# R2 prerender service example

This is a prepared example, **not an enabled deployment**. It materializes
only the public R2 files used by the renderer into
`/srv/ournotes-r2-prerender-content`. The existing
`/srv/ournotes-updater/content` remains the complete Nginx fallback store.

Run the manual `Publish R2 prerender image` workflow on a clean, reviewed
`main` commit. It passes that commit as `SOURCE_REVISION`, runs offline
runtime checks, publishes the image, and reports its immutable digest and
transfer sizes. Pin that digest in `/etc/ournotes/r2-prerender.env`. The image includes
Node, Python, pinned `boto3` and the small repository tools needed at
runtime. The sealed `code/compiled/prerender/render.mjs` was built with
esbuild `bundle: true`; it imports only Node built-ins and modules from the
same sealed code release. No Astro build or `site/node_modules` is needed on
the server. Its runtime needs no package installation and the prerender and
promotion containers run without network access. The wrapper checks the
image's source revision label before reading R2.

The publication workflow also saves a compressed Docker image artifact and
its SHA-256. When transferring this artifact to a server without GHCR pull
access, verify the archive SHA-256 locally, stream it into `docker load` over
SSH without storing the archive on that server, and set
`R2_PRERENDER_IMAGE=sha256:<image ID from the workflow summary>`. Docker
archives preserve image IDs but may omit registry digest associations. The
wrapper accepts this immutable local ID and never pulls GHCR in that mode;
it still verifies the source revision label before use. Keep the registry
digest in the deployment record as provenance.

For example, from the clean `main` checkout, build with
`docker build --pull -f deploy/Dockerfile.r2-prerender --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" -t ghcr.io/OWNER/otonote-r2-prerender:sha-"$(git rev-parse HEAD)" .`.
Push that tag using the registry's approved workflow and use the resulting
`@sha256:...` reference. Do not run `docker build` on the nearly full server.

Before installing the units:

1. Create the separate materialized content directory and ensure the selected
   UID/GID can write it and `/srv/ournotes-rendered`. Keep the latter on one
   filesystem so staged release renames remain atomic. Preserve the existing
   code and rendered directories. Do not bind the private R2 state bucket.
2. Issue a bucket-scoped **read/list only** R2 credential for
   `otonote-public-content`. Put it in
   `/etc/ournotes/r2-content-readonly.env` with mode `0600`; use a different
   token from the Actions writer for the private state bucket. Never pass
   credential values on the command line or commit them.
3. Measure the incremental disk need on the actual server: image download
   plus unpack if absent, both R2 selected release subsets (records, groups,
   gallery manifest, loading images), both staged HTML releases and transient
   renderer output. Add a stated margin to each, fill the three
   `R2_PRERENDER_*_FREE_BYTES` values, and check the wrapper's summed
   filesystem gate. A server with only about 197 MB free must gain space
   before image pull or first materialization; do not guess a fixed 24 GiB
   requirement for this small selected subset.
4. Stop and disable the old `ournotes-prerender.timer`, wait for its service
   to finish, then run the new oneshot manually. The old timer ignores the
   new lock. Only after both R2 pointers and the staged Global/JP HTML are
   verified should the new timer be enabled. The wrapper refuses to run while
   either old unit remains active and serializes its own runs with `flock`.

The run sequence is: preflight image and content space, pinned image
pull/check, materialize R2, require both regional pointers, then validate
both existing live HTML pairs. If their complete records, reports, required
pages and payload hashes still match the current code/content, the run ends
without creating a new stage. Only a changed or damaged view passes the
staging-space gate and renders both regions into a temporary directory;
promotion then checks both complete records, moves immutable releases, and
atomically replaces the two live symlinks. Staging failure leaves live HTML
untouched. Two separate symlinks cannot be switched
in one filesystem operation; promotion keeps the interval short and restores
the prior targets if a switch fails while the old timer is stopped.

Rollback order matters because new HTML may pin a release that exists only in
R2. Stop and disable `ournotes-r2-prerender.timer`, then wait for its service
to exit. With the old timer still disabled, use the old complete content store
to run `ournotes-prerender.service` once manually (or restore its validated old
HTML pointers). Verify both `current` and `current-jp` HTML links, their old
Global/JP content pointers, and the media under those pinned release paths in
the original Nginx store. Confirm the old pinned paths also remain available
through the still-active Worker Route during this short transition; without
that overlap, an instant rollback cannot guarantee uninterrupted media.
Only after old HTML is serving and both regions' media are verified should
the `/content/*` Worker Route be removed, followed by re-enabling the old
timer. Enabling that timer first and waiting for its next minute tick leaves
a window where R2-only HTML can request paths the old Nginx store lacks.
