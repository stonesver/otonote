# 可选外部更新触发器

默认使用 Actions 原生三时点调度。此触发器是待单独启用的替代方案，不得与原生调度同时启用。凭据与启用按[未结事项](../BACKLOG.md)另行确认。

## Contract

- Per-edition systemd timers use the shared 01:00, 06:00 and 11:00 UTC slots. The service has
  a 15-second network timeout, 45-second service timeout, 64 MiB memory limit and
  5% CPU quota. It stores only two bounded status files and lock files.
- Each invocation sends at most one request to the fixed GitHub API host and
  `content-r2.yml` workflow on `main`. HTTP redirects are refused. Credentials
  are never included in arguments, status JSON or remote response diagnostics.
- `mode=auto` resolves the current per-edition auto-promote variable inside
  Actions. Existing enabled variables and default-branch checks still apply.
  Manual `shadow`/`promote` behavior is preserved. The existing per-edition
  concurrency group remains responsible for serialization; running jobs are
  never cancelled by this trigger.
- A private per-region lock and persisted 15-minute slot reservation prevent
  duplicate local attempts. Reserve before sending: timeout or process death
  can mean the remote result is unknown, so the slot is not immediately retried.
  Persistent timers perform one catch-up after boot, not a backlog replay.
- `accepted` means GitHub accepted the request, not that a job started, produced
  content or published successfully. Keep the previous acceptance timestamp on
  failure; continue using Actions and delivery checks for release acceptance.
- The trigger is an independent operational leaf excluded from producer content
  invalidation. Unknown tools stay included. Changes to the workflow itself still
  invalidate receipts conservatively.

## Credential and installation boundary

Check the target Python and systemd versions before installation. The adapter supports older hosts; use a dedicated system user
`ournotes-trigger` without a login shell; do not rely on newer `LoadCredential`.
Install reviewed code under `/opt/ournotes-update-trigger/<revision>/` and point
`current` there. Use root-owned code and units; give only the service user access
to its 0700 state directory, created by `StateDirectory`.

Provision a separate fine-grained PAT or GitHub App installation credential for
this repository with **Actions: write** (and GitHub's required metadata access).
GitHub does not scope this permission to only dispatching one workflow: it can
also manage other Actions runs within the selected repository. Do not transfer a
developer's broad personal CLI credential. A long-lived installation must also
arrange credential expiry/rotation; this first adapter reads an already valid
token file and does not mint or refresh GitHub App tokens.

Place the token at `/etc/ournotes-update-trigger/github-token`, owned by
`root:ournotes-trigger`, mode 0640, in a root-owned directory with mode 0750.
The script accepts that dedicated-group read-only credential or an owner-private
0600 file; it rejects symlinks, public readability and writable group access.
No token value belongs in this repository, an issue, PR, run log or chat.

Code/CI and compatibility validation can finish before credential provisioning.
Do not enable the timers until the dedicated credential is provisioned and one
manual dispatch per edition is accepted, with an associated Actions run verified.
Observe timer firing and actual run creation separately: this removes dependence
on GitHub's cron trigger, not on Actions availability or runner capacity.

## Rollout and rollback

1. Verify the reviewed adapter and workflow together, including production and
   unchanged-run acceptance. Keep a recoverable previous program version.
2. Install the versioned code and service units with timers disabled. Validate
   source compatibility and units on the host. Keep the frontend untouched.
3. Provision the dedicated credential, perform one per-edition dispatch and inspect
   bounded status files plus matching Actions runs. Then enable the timers.
4. If explicitly switching to external timers, remove the native `schedule`
   trigger while retaining `workflow_dispatch`. The retired fast-poll variables
   no longer switch scheduling modes. Enable only one scheduler.
5. Roll back by stopping/disabling these two timers and restoring the reviewed
   native three-slot schedule. Keep existing jobs running. Prior published
   content and frontend are untouched.

Validation covers request binding and auto policy, per-region/slot deduplication,
unknown outcomes, HTTP errors without response-body disclosure, rejected redirects,
private credential/state permissions, malformed state, and concurrent invocations.

References: [GitHub workflow dispatch and required permissions](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event),
[systemd service execution and credential support](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).
