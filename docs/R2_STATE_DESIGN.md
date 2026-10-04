# Efficient R2 private-state checkpoint and restore

## Decision

Global's first R2 checkpoint can read existing server files in place or a local copy staged with hard links preserved. A local checkpoint records the future Actions root `/srv/ournotes-updater/app` explicitly while reading bytes from a different `--root`; no absolute updater JSON is rewritten. It will not delete or rewrite the old workspace. Its stable selection includes the entire `sync-complete` directory, the active costume input plan, the old formal input tree for fallback, `cache`, `clients`, the state and package receipts, baseline, signing tool, and a separate R2 updater config. `builds` and `conversions` remain on the old server but are omitted from the R2 checkpoint because the updater rebuilds/re-encodes cache misses. The same selection must be stored in `R2_GLOBAL_STATE_PATHS` and used for the first checkpoint and all later Actions runs.

The existing server uses hard links extensively. For the proposed selection, `du -sb` counts about 9.4 GB of unique inodes while the manifest lists about 48.1 GB across 180,017 paths. The manifest is about 65.9 MB. The current 16 MiB control-object limit and per-path R2 upload, readback, and restore make this selection impractical.

## Alternatives considered

1. Keep all old workspace paths and use a very large runner. This retains every cache but makes a larger manifest and repeats storage and transfer for linked files.
2. Select only the current v300 sync directory. This reduces the first run but fails to include directories created by later updates under a static Actions allowlist.
3. **Selected:** keep the dynamic `sync-complete` parent, omit regenerable build and conversion caches, and make the content-addressed state adapter reuse identical R2 objects while preserving only genuine source hard links on restore.

## Adapter changes

- Write manifest schema 2, recording `hardlinkTo` only when two selected paths have the same device and inode at inventory time. Continue accepting schema 1 on restore. Preserve strict canonical ROOT/selection validation and reject forward, cyclic, outside-allowlist, or mismatched hard-link references. Increase only the manifest-object bound to 128 MiB; keep pointer objects at the existing 16 MiB bound. The proposed 65.9 MB manifest fits with room for new versions; overflow must fail before pointer promotion.
- Permit an explicit absolute `--recorded-root` for checkpoint only, so a local staging directory can produce a manifest targeted to the Actions stable root. Restore and inspect continue to require an existing canonical root that exactly matches the manifest.
- During checkpoint, inventory every selected path and its SHA-256. Upload and fully read back each unique `(sha256, size)` object once. Verify that every selected local file still matches its inventory hash before committing the manifest and pointer. The pointer remains the final atomic operation.
- During restore, download and verify each unique `(sha256, size)` object once into the staging directory. Copy identical content into a separate inode when the source paths were independent; use `os.link` only for recorded source hard links. Move staged paths into place only after all objects verify. Any object failure leaves the destination tree untouched. Do not follow source symlinks or relax the restore allowlist.
- Report both logical `totalBytes` and physical `requiredBytes` in read-only `inspect`, counting one copy for each original inode group. The Actions free-space gate uses `requiredBytes + 8 GiB`, and still reports `df` and the logical size. This is a lower bound, so the real runner must pass shadow-run peak checks before production enablement.

## Validation

- Fake-bucket tests cover repeated file content, single upload/download verification, preservation of genuine hard links and independence of separate files with equal bytes, and rollback when a unique object is damaged.
- Tests preserve rejection of wrong ROOT, changed selection, symlinks, and pointer conflicts.
- A dry-run inventory of the old server's final path selection must fit the manifest bound before any R2 write. The first checkpoint is followed by an isolated restore and Global shadow run; no public pointer or old-server file is changed during this stage.

JP's local-machine seed and the official JP endpoint's HTTP 403 are separate gates. This change does not make JP unattended publication succeed by itself.
