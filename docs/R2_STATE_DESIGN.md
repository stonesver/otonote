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

## 2026-10-05: verified restore evidence and JP working-set retention

The original migration above is complete. The old server producer has been retired; the stable ROOT remains an Actions runner contract. Image derivatives now live in checkpointed `cache/image-conversions`. See [current operations acceptance](plans/2026-10-05-post-migration-acceptance.md) for deployment evidence.

Full runs showed a second download of every unique private object during checkpoint, after restore had already downloaded and SHA-verified it. The optional `--verification-cache` records evidence only after a successful restore, outside ROOT in the ephemeral runner's private temporary directory. It is an owned regular mode-600 file, bound to endpoint/bucket, canonical ROOT, region, selections, pointer and manifest. Each entry pairs the SHA-verified GET body with that same response's opaque ETag and size. Object names or user-defined S3 metadata never establish verification.

Checkpoint still inventories and hashes every local file. It obtains a fresh bounded, paginated object listing and skips the second full GET only when the restored evidence and fresh object identity match the local SHA/size. New, missing, or changed objects use the existing full-read and conditional-upload path. Missing evidence or an unsupported adapter retains the old path; malformed or mismatched evidence fails closed. The final local rehash, hard-link checks, immutable manifest readback and pointer compare-and-swap are retained. Evidence is neither checkpointed nor saved as a reusable CI artifact.

JP previously retained every code-fingerprint run without connecting its prior raw-resource cache to the next input build. The new flow validates the previous successful run's plan and catalog, reuses matching raw resources into the new run together with a current receipt, and keeps the full current successful run and shared caches. After the production receipt is recorded and checked, a bounded local retention step removes only other run directories from the ephemeral runner. The R2 allowlist stays `output/r2-jp`; prior immutable R2 manifests and objects remain available. A failed production or failed validation does not prune or advance the checkpoint.

The measured JP two-run state has 99,881 paths and 27.39 GB logical bytes, versus 49,944 paths and 13.81 GB for the current run and seeds. CAS object bytes differ by only about 37 MB. Retention principally reduces local materialization and repeated hashing; verified restore evidence addresses the duplicate network reads.
## Global 热恢复工作集

Global checkpoint 可通过 `--global-working-set-config` 和 `--production-result` 启用当前生产绑定的工作集筛选。仅在本次生产结果、私有收据、可信输入、输入计划和同步状态一致时，排除未被当前控制文档引用的托管 `sync-complete` 历史代。未知目录、软链接、缺失引用或预检失败均中止，不写新指针。

此筛选不删除本地文件或任何 R2 对象，不改变恢复 allowlist，也不移除初始输入、客户端可信基线和缓存。历史完整 manifest 保持不可变，回退仍使用历史 manifest。当前输入引用旧代文件时保留对应整代；不按版本号或目录时间推断可删性。

checkpoint 结果报告清单字节数、上限、80% 预算预警和排除代数。超限在写任何对象前失败，错误给出实际字节数。工作流结果汇总容忍失败步骤留下的空/截断 JSON，不再用二次解析错误遮盖实际失败；原有上传、checkpoint、公共晋级顺序不变。
