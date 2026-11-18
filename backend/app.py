"""FastAPI adapter for the Dynamic Query Service.

The adapter is intentionally thin: parameter parsing, status code mapping,
and HTTP caching. Every query result is built by ``DatasetQueryModule``,
which is the only module allowed to touch the release tree.

The adapter is intentionally minimal:

- no Swagger / ReDoc / OpenAPI schema routes in production;
- no global side effects on import (``create_app`` is the only entry point);
- no absolute disk paths or stack traces in error responses.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from backend.config import (
    ConfigurationError,
    EnabledEnvironment,
    QueryServiceConfig,
    load_from_environment,
)
from backend.contracts import (
    Channel,
    Dataset,
    Locale,
    Principal,
    QuerySpec,
    Region,
)
from backend.identity import (
    AdapterCredential,
    BindingModule,
    IdentityRepository,
)
from backend.query import DatasetIntegrityError, DatasetQueryModule


_LOGGER = logging.getLogger("backend.app")


@dataclass(frozen=True)
class _AppState:
    config: QueryServiceConfig
    module: DatasetQueryModule
    binding_module: Optional[BindingModule] = None
    adapters: tuple[AdapterCredential, ...] = field(default_factory=tuple)


# ---------------------------------------------------------------------------
# Error envelope
# ---------------------------------------------------------------------------


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    response = JSONResponse(
        status_code=status_code,
        content={"error": code, "message": message},
    )
    return response


# ---------------------------------------------------------------------------
# Parameter parsing
# ---------------------------------------------------------------------------


def _parse_region(raw: str | None) -> Region:
    try:
        return Region(raw) if raw is not None else None  # type: ignore[return-value]
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_region", "message": str(exc)},
        ) from exc


def _parse_channel(raw: str | None) -> Channel:
    try:
        return Channel(raw) if raw is not None else None  # type: ignore[return-value]
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_channel", "message": str(exc)},
        ) from exc


def _parse_locale(raw: str | None) -> Locale:
    try:
        return Locale(raw) if raw is not None else None  # type: ignore[return-value]
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_locale", "message": str(exc)},
        ) from exc


def _parse_limit(raw: str | None) -> int:
    if raw is None or raw == "":
        return 20
    try:
        value = int(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_limit", "message": str(exc)},
        ) from exc
    if value < 1 or value > 100:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_limit",
                "message": f"limit must be 1..100, got {value}",
            },
        )
    return value


def _parse_cursor(raw: Optional[str]) -> Optional[str]:
    if raw is None or raw == "":
        return None
    padding = "=" * (-len(raw) % 4)
    try:
        decoded = base64.urlsafe_b64decode(raw + padding)
        payload = json.loads(decoded.decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_cursor",
                "message": f"cursor is not a valid opaque token: {exc}",
            },
        ) from exc
    offset = payload.get("o") if isinstance(payload, dict) else None
    if not isinstance(offset, int) or offset < 0:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_cursor",
                "message": "cursor must encode a non-negative integer offset",
            },
        )
    return raw


def _build_query_spec(
    region: Region,
    channel: Channel,
    locale: Locale,
    limit: int,
    cursor: Optional[str],
) -> QuerySpec:
    try:
        return QuerySpec(
            region=region,
            channel=channel,
            locale=locale,
            limit=limit,
            cursor=cursor,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_query_spec", "message": str(exc)},
        ) from exc


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


def _check_environments(
    state: _AppState,
) -> tuple[bool, list[dict[str, str]], Optional[str]]:
    resolved: list[dict[str, str]] = []
    integrity_error: str | None = None
    for environment in state.config.enabled_environments:
        try:
            release = state.module._repository.load_current_release(  # noqa: SLF001 - intentional internal access
                environment.region, environment.channel
            )
        except DatasetIntegrityError as exc:
            integrity_error = str(exc)
            continue
        if release is None:
            continue
        content_release_id, _manifest = release
        resolved.append(
            {
                "region": environment.region.value,
                "channel": environment.channel.value,
                "contentReleaseId": content_release_id,
            }
        )
    return bool(resolved), resolved, integrity_error


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def create_app(
    config: QueryServiceConfig,
    *,
    module: Optional[DatasetQueryModule] = None,
    binding_module: Optional[BindingModule] = None,
    adapters: Sequence[AdapterCredential] = (),
) -> FastAPI:
    """Build a FastAPI app bound to ``config``.

    ``module`` is optional and exists for tests; production callers should
    leave it ``None`` so the factory wires the default
    :class:`DatasetQueryModule` from ``config.release_root``.

    ``binding_module`` and ``adapters`` together enable the loopback
    ``/internal/v1/`` routes. Both must be provided for the routes to
    answer; otherwise the routes are absent (returning 404).
    """

    if module is None:
        module = DatasetQueryModule(release_root=config.release_root)

    state = _AppState(
        config=config,
        module=module,
        binding_module=binding_module,
        adapters=tuple(adapters),
    )

    app = FastAPI(
        title="OurNotes Dynamic Query Service",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.ournotes = state  # type: ignore[attr-defined]

    def _state() -> _AppState:
        return app.state.ournotes  # type: ignore[attr-defined]

    def _cache_headers() -> dict[str, str]:
        return {
            "Cache-Control": (
                f"max-age={config.cache_control_max_age}, public"
            )
        }

    # ----- liveness -------------------------------------------------------

    @app.get("/api/v1/health/live")
    def health_live() -> JSONResponse:
        return JSONResponse(content={"status": "live"})

    # ----- readiness ------------------------------------------------------

    @app.get("/api/v1/health/ready")
    def health_ready() -> JSONResponse:
        ready, environments, integrity_error = _check_environments(_state())
        if integrity_error is not None and not ready:
            _LOGGER.error("readiness integrity failure: %s", integrity_error)
            return _error(
                503, "integrity_check_failed", "release pointer integrity failed"
            )
        if not ready:
            return JSONResponse(
                status_code=503,
                content={"status": "not_ready", "environments": []},
            )
        return JSONResponse(
            content={"status": "ready", "environments": environments},
        )

    @app.get("/api/v1/player-rankings")
    def player_rankings(server: str = Query(...), board: str = Query("auto"),
                        event: Optional[str] = Query(None), music: str = Query(""),
                        cursor: Optional[str] = Query(None), limit: int = Query(50)) -> JSONResponse:
        from backend.player_rankings import query_player_rankings
        try:
            result = query_player_rankings(_state().config.data_root / "observations", server=server,
                                          board=board, event=event, music=music, cursor=cursor, limit=limit)
        except (ValueError, KeyError, TypeError):
            return _error(400, "invalid_ranking_query", "Invalid ranking query or snapshot")
        except OSError:
            return _error(503, "rankings_unavailable", "Rankings are temporarily unavailable")
        return JSONResponse(content=result, headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/arena-rankings")
    def arena_rankings(server: str = Query(...), season: str = Query(...), band: str = Query(...),
                       cursor: Optional[str] = Query(None), limit: int = Query(10), rank: int = Query(1)) -> JSONResponse:
        from backend.arena_rankings import query_arena_rankings, RankingCursorChanged
        try:
            result = query_arena_rankings(_state().config.data_root / "observations", server=server,
                                          season=season, band=band, cursor=cursor, limit=limit, rank=rank)
        except RankingCursorChanged:
            return _error(409, "arena_ranking_snapshot_changed", "Reload rankings before continuing")
        except (ValueError, KeyError, TypeError):
            return _error(400, "invalid_arena_ranking_query", "Invalid arena ranking query")
        except OSError:
            return _error(503, "arena_rankings_unavailable", "Arena rankings are temporarily unavailable")
        return JSONResponse(content=result, headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/arena-population")
    def arena_population(server: str = Query(...), season: str = Query(...), band: str = Query(...)) -> JSONResponse:
        from backend.arena_population import query_population
        try:
            result = query_population(_state().config.data_root / "observations",server=server,season=season,band=band)
        except (ValueError,KeyError,TypeError):
            return _error(400,"invalid_arena_population","Invalid population observation")
        except OSError:
            return _error(503,"arena_population_unavailable","Population observation unavailable")
        return JSONResponse(content=result,headers={"Cache-Control":"no-store"})

    # ----- dataset routes -------------------------------------------------

    def _register_dataset_route(path: str, dataset: Dataset) -> None:
        def handler(
            region: str = Query(...),
            channel: str = Query(...),
            locale: str = Query(...),
            limit: str = Query("20"),
            cursor: Optional[str] = Query(None),
        ) -> JSONResponse:
            region_value = _parse_region(region)
            channel_value = _parse_channel(channel)
            locale_value = _parse_locale(locale)
            limit_value = _parse_limit(limit)
            cursor_value = _parse_cursor(cursor)
            spec = _build_query_spec(
                region_value,
                channel_value,
                locale_value,
                limit_value,
                cursor_value,
            )
            try:
                result = _state().module.query(dataset, spec)
            except DatasetIntegrityError as exc:
                _LOGGER.error(
                    "integrity failure on %s for %s/%s/%s: %s",
                    dataset.value,
                    region_value.value,
                    channel_value.value,
                    locale_value.value,
                    exc,
                )
                return _error(
                    503, "integrity_check_failed", "release integrity failed"
                )
            return JSONResponse(
                content=result.to_dict(),
                headers=_cache_headers(),
            )

        handler.__name__ = f"query_{dataset.value}"  # type: ignore[attr-defined]
        app.add_api_route(
            f"/api/v1{path}",
            handler,
            methods=["GET"],
            name=f"query_{dataset.value}",
        )

    for path, dataset in (
        ("/events", Dataset.EVENTS),
        ("/rankings", Dataset.RANKINGS),
        ("/gacha-pools", Dataset.GACHA_POOLS),
        ("/shops", Dataset.SHOPS),
    ):
        _register_dataset_route(path, dataset)

    # ----- internal binding routes --------------------------------------

    if binding_module is not None and adapters:

        def _authorize(request: Request) -> AdapterCredential:
            state_obj = _state()
            header = request.headers.get("authorization") or ""
            if not header.lower().startswith("bearer "):
                raise HTTPException(
                    status_code=401,
                    detail={"error": "unauthorized", "message": "missing Bearer credential"},
                )
            token = header.split(" ", 1)[1].strip()
            matched: Optional[AdapterCredential] = None
            for adapter in state_obj.adapters:
                if adapter.bearer_token == token:
                    matched = adapter
                    break
            if matched is None:
                raise HTTPException(
                    status_code=401,
                    detail={"error": "unauthorized", "message": "Bearer credential rejected"},
                )
            return matched

        def _principal_from_headers(
            adapter: AdapterCredential, request: Request
        ) -> Principal:
            namespace = request.headers.get("x-identity-namespace") or ""
            user_id = request.headers.get("x-platform-user-id") or ""
            if not namespace or not user_id:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": "missing_identity_headers",
                        "message": (
                            "X-Identity-Namespace and X-Platform-User-Id "
                            "are required"
                        ),
                    },
                )
            if namespace not in adapter.allowed_namespaces:
                raise HTTPException(
                    status_code=403,
                    detail={
                        "error": "namespace_not_allowed",
                        "message": (
                            f"adapter {adapter.adapter_id} cannot declare "
                            f"identity namespace {namespace}"
                        ),
                    },
                )
            return Principal(
                adapter_id=adapter.adapter_id,
                identity_namespace=namespace,
                platform_user_id=user_id,
            )

        @app.get("/internal/v1/bindings")
        async def internal_list_bindings(
            environmentId: str = Query(..., alias="environmentId"),
            request: Request = None,  # type: ignore[assignment]
        ) -> JSONResponse:
            adapter = _authorize(request)
            principal = _principal_from_headers(adapter, request)
            try:
                bindings = _state().binding_module.list_bindings(
                    principal, environmentId
                )
            except ValueError as exc:
                raise HTTPException(
                    status_code=400,
                    detail={"error": "invalid_environment_id", "message": str(exc)},
                ) from exc
            return JSONResponse(
                content={
                    "items": [_binding_to_public(binding) for binding in bindings],
                }
            )

        @app.put("/internal/v1/bindings/{environment_id}")
        async def internal_upsert_binding(
            environment_id: str,
            request: Request,
        ) -> JSONResponse:
            adapter = _authorize(request)
            principal = _principal_from_headers(adapter, request)
            try:
                payload = await _read_json_body_async(request)
            except ValueError as exc:
                raise HTTPException(
                    status_code=400,
                    detail={"error": "invalid_body", "message": str(exc)},
                ) from exc
            game_account_id = payload.get("gameAccountId")
            if not isinstance(game_account_id, str) or not game_account_id.strip():
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": "invalid_body",
                        "message": "gameAccountId must be a non-empty string",
                    },
                )
            binding_input = _build_binding_input(
                principal, environment_id, game_account_id
            )
            try:
                binding = _state().binding_module.upsert_binding(
                    principal, binding_input
                )
            except ValueError as exc:
                raise HTTPException(
                    status_code=400,
                    detail={"error": "invalid_binding_input", "message": str(exc)},
                ) from exc
            _LOGGER.info(
                "binding upsert: %s",
                binding.summary(),
            )
            return JSONResponse(content=_binding_to_public(binding))

        @app.delete("/internal/v1/bindings/{binding_id}")
        async def internal_remove_binding(
            binding_id: str, request: Request
        ) -> JSONResponse:
            adapter = _authorize(request)
            principal = _principal_from_headers(adapter, request)
            try:
                _state().binding_module.remove_binding(principal, binding_id)
            except BindingModule.NotVisible:
                raise HTTPException(
                    status_code=404,
                    detail={
                        "error": "binding_not_found",
                        "message": "binding does not exist for the current principal",
                    },
                )
            return JSONResponse(status_code=204, content=None)

    return app


def create_app_from_environment() -> FastAPI:
    """Assemble the production app from container environment variables."""

    config = load_from_environment()
    repository = IdentityRepository(config.identity_root / "identity.sqlite3")
    repository.initialize()
    return create_app(
        config,
        binding_module=BindingModule(repository),
    )


def _binding_to_public(binding) -> dict[str, Any]:
    return {
        "id": binding.id,
        "identityNamespace": binding.identity_namespace,
        "platformUserId": binding.platform_user_id,
        "gameEnvironmentId": binding.game_environment_id,
        "gameAccountId": binding.game_account_id,
        "verificationStatus": binding.verification_status.value,
        "createdAt": binding.created_at,
        "updatedAt": binding.updated_at,
    }


async def _read_json_body_async(request: Request) -> Mapping[str, Any]:
    body_bytes = await request.body()
    return _parse_json_bytes(body_bytes)


def _parse_json_bytes(body_bytes: bytes) -> Mapping[str, Any]:
    try:
        payload = json.loads(body_bytes or b"{}")
    except json.JSONDecodeError as exc:
        raise ValueError(f"body is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("body must be a JSON object")
    return payload


def _build_binding_input(
    principal: Principal, environment_id: str, game_account_id: str
):
    from backend.contracts import BindingInput  # local import keeps the surface tight

    return BindingInput(
        identity_namespace=principal.identity_namespace,
        platform_user_id=principal.platform_user_id,
        game_environment_id=environment_id,
        game_account_id=game_account_id,
    )

__all__ = ["create_app", "create_app_from_environment"]
