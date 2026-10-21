# 私有状态 checkpoint 与恢复

GitHub runner 是临时环境，持久输入、受信客户端、收据和缓存由私有 R2 checkpoint 恢复。公开内容库不属于私有状态选择。真实配置及目录选择留在仓库外，本文只记录契约。

## 身份与原子性

manifest 绑定规范化 ROOT、区服、精确 allowlist、文件 SHA-256 和大小。checkpoint 可用 `--recorded-root` 记录目标运行根，读取本地暂存字节；恢复必须使用与 manifest 匹配的规范化根，不改写历史状态中的绝对路径。指针在对象上传、读回和本地最终校验后通过 CAS 切换。

schema 2 仅对 inventory 时同设备／inode 的源硬链接记录 `hardlinkTo`；仍接受 schema 1。拒绝循环、向前引用、越界、内容不匹配与符号链接。同内容独立文件恢复为独立 inode，不能为了省空间把它们误合为硬链接。所有对象验证完成后才将 staged 路径放入目标，失败保留原目标树。

manifest 上限 128 MiB，指针仍为 16 MiB。`inspect` 同时报告逻辑 `totalBytes` 和按原 inode 组计算的 `requiredBytes`；空间门槛仍需包含恢复、生产和缓存峰值，不能把物理输入大小当作总容量需求。

## 减少重复读取

同一 `(sha256, size)` 对象每阶段传输并完整验证一次。硬链接在单个校验阶段可复用摘要；传输后开始新的本地字节验证阶段，不能用 inode／mtime 代替最终完整性校验。

可选 `--verification-cache` 只由成功恢复生成，位于 ROOT 外临时私有目录，为自有普通 `0600` 文件；绑定 endpoint／bucket、ROOT、区服、选择、指针与 manifest。每项同时记录 SHA 校验过的 GET 字节、该响应的 ETag 和大小。checkpoint 的新鲜分页 listing 与本地 SHA／大小及旧证据一致时，可跳过第二次完整 GET。对象名和自声明 metadata 不构成验证证据。缺少证据走完整读取，损坏或错绑证据拒绝。证据不进入 checkpoint 或可复用 CI artifact。

## 工作集与保留

Global 的 `--global-working-set-config` 与 `--production-result` 仅在生产结果、私有收据、输入计划和同步状态一致时排除未引用的托管历史代。引用旧代文件时保留整代。未知目录、缺引用、软链接或预检失败停止，不按目录日期猜测可删性。此筛选不删除本地或远端对象，不改变恢复 allowlist；历史 manifest 继续不可变。

JP 验证上一成功计划和 catalog 后复用匹配原资源，保留当前成功运行与共享缓存。仅在生产收据记录并验证后，才在临时 runner 中清理受管旧运行目录；失败不清理、不推进 checkpoint。远端历史 manifest／对象仍由独立运维保留规则管理。

动态资源父目录、客户端信任基线、配置、input plan 和缓存必须按实际引用选入。可重建的 build／conversion 数据可省略，但不能删掉唯一恢复依据。接近 manifest 预算时先审阅工作集，超限应在对象写入前失败。

验证覆盖硬链接与同内容独立文件、对象损坏、传输期间修改、路径／选择错绑、CAS 冲突和失败恢复。真实 shadow 的空间、时长与后续无变化运行分别验收，不从 mock 结果推断云端性能。
