# JP Version API runner egress

The trusted JP 1.0.4 Version request returned HTTP 200 / gRPC 0 through the
operator's Japan node. The same request was refused from the previous direct
and US routes. This establishes a working route, not a promise that every
Japanese address will work.

## Interface and scope

```sh
python -m tools.jp_version_egress --binary /absolute/path/to/mihomo -- producer-command arguments
```

The workflow downloads a pinned mihomo release and verifies its SHA-256 before
calling this helper. The helper does not download clients or subscriptions.
The workflow supplies `OURNOTES_JP_PROXY_NODE` as one JSON object through a
secret environment variable. Transferring the actual node credentials into
GitHub requires separate user approval; preparing this code does not transfer
them.

The accepted node fields are `type` (exactly `trojan`), `server`, integer `port`,
`password`, optional `name`, `sni`, boolean `udp`, `skip-cert-verify` (only false),
and `network` (`tcp` or `grpc`). The gRPC transport requires exactly
`grpc-opts: {"grpc-service-name": "..."}`. Unknown and duplicate fields are
rejected. Local schema inspection confirmed that the working node uses these
field names and already has TLS verification enabled. The separately prepared
node JSON stays in a mode-600 file outside the repository.

The helper replaces the node name, disables UDP, forces TLS verification, and
generates its own configuration. It listens at `127.0.0.1:17897`, disables LAN,
TUN and internal DNS listeners, and defines exactly two rules:

```text
DOMAIN,api.bang-dream-on.jp,jp-version-node
MATCH,REJECT
```

No controller, provider, subscription, fallback group or external rule files
are accepted. The producer receives only
`OURNOTES_JP_VERSION_PROXY=http://127.0.0.1:17897`; the node secret is removed
from its environment. The JP API adapter applies that variable only to its
allowlisted Version RPC, preserving the existing CDN path. This wrapper limits
traffic sent to its listener; it is not an operating-system sandbox for the
producer's other network traffic.

Supplying both a node and `OURNOTES_JP_VERSION_PROXY` is an error. With no node,
the helper executes the command with the existing environment minus the node
variable, preserving an explicitly configured proxy URL. Containers using the
managed local node need host networking on the Linux runner, added by the
workflow only for this mode.

## Lifecycle and acceptance

The private temporary directory is mode 700. The generated config and mihomo
log are mode 600. `log-level: silent` is set and process output remains in the
private log even on failure. Errors do not include client output or node data.
The proxy process receives only a minimal environment, without pipeline/R2
credentials. Child process groups are stopped and temporary files removed on
normal exit, failure, SIGINT, SIGTERM and SIGHUP; an OS-level SIGKILL cannot run
cleanup, so this is intended for the ephemeral hosted runner.

Readiness verifies only the local listener. The existing authenticated Version
probe must still succeed before production can publish. If the client exits
during production, the helper terminates the producer and fails. There is no
automatic route rotation, endpoint substitution, or acceptance of refused
responses.

Tests use synthetic credentials and mocked processes, including a real SIGTERM
delivered to the installed handler. A bounded local test with the installed
Clash Verge mihomo and the separately prepared private node did start the
isolated listener, but the single Version request failed with curl 35 (TLS
connection failure). All created processes exited and port 17897 was closed
afterward. The existing local Clash also has TUN and DNS enabled, so that
failure does not establish the cause or the hosted runner's behavior.
The operator subsequently authorized storing that single node in the
`content-r2-production` environment's `OURNOTES_JP_PROXY_NODE` secret. The
[hosted runner probe](https://github.com/stonesver/otonote/actions/runs/37252306052)
passed on 2026-10-05 with the pinned binary: HTTP 200 / gRPC 0, client 1.0.4,
master and resource version 1.0.0.350. This verifies the hosted Version path;
complete resource production and publication still have their own acceptance
gates. The subsequent shadow run is
[37253004172](https://github.com/stonesver/otonote/actions/runs/37253004172).

The manual **Probe JP version through configured egress** workflow downloads
only the content-addressed, pinned client metadata from private R2 and verifies
its SHA-256. It makes one Version request and retains only the sanitized
observation as a seven-day artifact. It never writes R2 or enables schedules.
Production uses the same pinned client installer and process wrapper.

Protocol references: [mihomo Trojan fields](https://wiki.metacubex.one/en/config/proxies/trojan/)
and [general settings](https://wiki.metacubex.one/en/config/general/).

When the Version RPC returns a nonzero gRPC status, the probe records that
status and a bounded, sanitized `grpc-message` in its private seven-day
artifact and failed-step log. URLs, credential assignments, token-shaped
strings, and control characters are removed. Authentication headers, response
bodies, proxy configuration, and mihomo logs are not included. This diagnostic
does not change the fail-closed publication gate.
