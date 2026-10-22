from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))


class WorkerDeliveryTest(unittest.TestCase):
    def test_worker_image_has_required_runtime_and_safe_default_command(self) -> None:
        dockerfile = (REPO_ROOT / "Dockerfile.worker").read_text(encoding="utf-8")

        self.assertIn(
            "ARG NODE_BASE_IMAGE=node:22.23.4-bookworm-slim", dockerfile
        )
        self.assertIn("FROM ${NODE_BASE_IMAGE} AS runtime-base", dockerfile)
        self.assertIn("python3-venv", dockerfile)
        self.assertIn("ffmpeg", dockerfile)
        self.assertIn("FROM runtime-base AS python-wheel-builder", dockerfile)
        self.assertIn("build-essential", dockerfile)
        self.assertIn("python3-dev", dockerfile)
        self.assertIn(
            "/opt/ournotes-wheel-venv/bin/pip install --no-cache-dir wheel==0.45.1",
            dockerfile,
        )
        self.assertIn("COPY --from=python-wheel-builder /wheels /wheels", dockerfile)
        self.assertIn("npm ci --ignore-scripts", dockerfile)
        self.assertIn('VOLUME ["/data", "/site-releases"]', dockerfile)
        self.assertIn('"run", "--all-enabled"', dockerfile)

    def test_build_context_excludes_private_and_generated_resource_roots(
        self,
    ) -> None:
        dockerignore = (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8")

        self.assertTrue(dockerignore.startswith("**\n"))
        for pattern in (
            "**/*.apk",
            "**/*.zip",
            "**/phone_dump/",
            "**/data/",
            "**/*.secret",
            "**/*.credentials",
            "**/site/src/data/generated/",
            "**/site/public/media/",
            "**/site/public/data/",
            "**/dist-matrix/",
        ):
            self.assertIn(pattern, dockerignore)

    def test_timer_invokes_only_the_all_enabled_worker_entrypoint(self) -> None:
        service = (REPO_ROOT / "deploy/resource-worker.service").read_text(
            encoding="utf-8"
        )
        timer = (REPO_ROOT / "deploy/resource-worker.timer").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            "python3 -m tools.resource_pipeline.cli run --all-enabled "
            "--data-root /data",
            service,
        )
        self.assertIn("source=/srv/ournotes-data,target=/data", service)
        self.assertIn("source=/srv/ournotes-site,target=/site-releases", service)
        self.assertIn("OnUnitActiveSec=15m", timer)
        self.assertIn("Persistent=true", timer)

    def test_ci_keeps_site_builds_out_of_the_worker_runtime_image(self) -> None:
        script = (REPO_ROOT / "tools/ci_verify.sh").read_text(encoding="utf-8")

        self.assertIn("npm run catalog:preflight", script)
        self.assertIn("node --test tests/*.test.mjs", script)
        self.assertIn("npm exec -- astro check", script)
        self.assertIn("npm run build -- --output", script)
        self.assertIn("test_browser_regression.py", script)
        self.assertLess(
            script.index("npm run catalog:preflight"),
            script.index("node --test tests/*.test.mjs"),
        )
        container_branch = script.split(
            'CI_EVIDENCE_MODE="local-runtime"\nelse',
            maxsplit=1,
        )[1].split('CI_EVIDENCE_MODE="worker-container"', maxsplit=1)[0]
        self.assertNotIn("cd /app/site", container_branch)
        self.assertNotIn("release_build.py", container_branch)
        self.assertNotIn("perf:budget", container_branch)
        self.assertNotIn("run_performance_gate.sh", container_branch)
        self.assertNotIn("--performance-contract", container_branch)

        package_json = (REPO_ROOT / "site/package.json").read_text(
            encoding="utf-8"
        )
        self.assertIn('"catalog:preflight"', package_json)
        self.assertIn('"build": "python3 ../tools/release_build.py"', package_json)


if __name__ == "__main__":
    unittest.main()
