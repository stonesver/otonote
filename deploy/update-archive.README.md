# 官方更新档案：本地使用与外置配置

程序默认关闭。本文定义本地验证、外置配置、上线与回退流程；实际启用状态需核对环境与运行回执，不能从模板或本地测试推断。未结验收见[待办](../docs/BACKLOG.md)。

2026-10-20 合入的[上线验收](https://github.com/stonesver/otonote/pull/111)已确认双服启用、真实存储条件写入与权限隔离、管理服务认证和出站边界。首次正式 CLI 运行仅建立基线，未保存历史资源；该记录尚未确认托管 runner 首轮及三个自然时点。本页不保留现场日志，也不将既有验收当作实时健康状态。解密／特殊音频预览仍取决于私密解码引用及转换器；未配置完整 APK 时不补拉历史客户端。

## 本地验收

使用 Python 3.11+、Node 22：

```sh
python -m venv /tmp/ournotes-archive-venv
/tmp/ournotes-archive-venv/bin/pip install -r requirements-admin.txt -r backend/update_archive/requirements.txt PyYAML==6.0.2
/tmp/ournotes-archive-venv/bin/python -m unittest discover -s tests -p '*archive*.py' -q
/tmp/ournotes-archive-venv/bin/python -m backend.update_archive.demo
```

打开 `http://127.0.0.1:18086/#archive`。演示只在临时目录生成图片、文本、WAV 和待选条目，退出即清除；默认只读。需要验证确认/补存交互时加 `--writable`，它只允许操作演示合成数据，不读取正式配置。

单次命令为 `python -m backend.update_archive --config /外置路径/archive.json --region global`（或 `jp`）。不传配置或 `enabled: false` 时直接返回 disabled，不初始化 S3。不要把真实配置、客户端材料、桶凭据或输出提交进 Git。

仅为已保存原件补生成预览时，使用 `python -m backend.update_archive --config /外置路径/archive.json --region global --previews-only`。此入口仍使用归档自己的区服锁、可信解码材料和既有运行预算，不执行官方资源检测、原件补存或排队清理；不调用整份网站生产工作流。积压较多时可重复单次执行，或等待下一次既有归档轮次继续。

## 配置和来源材料

[update-archive.example.json](update-archive.example.json) 是关闭状态的模板，里面的路径和桶名都是待替换占位符。工作台配置的可选 `archive` 段使用相同的 `schemaVersion / enabled / storage`；原管理配置仍可启动。

- 两服任务必须使用**同一份外置归档配置、同一私有归档桶和固定前缀** `update-archive/v1/`。工作台也连接同一存储。2 GiB 是共同账本的硬上限，不是每服各 2 GiB。
- `storage.type: s3` 只允许归档前缀下的控制账本和对象读写。归档桶须独立于生产 checkpoint 桶，关闭版本保留/其他隐式历史副本，避免账本外计费副本。凭据只授予此归档根的必要权限。
- `OURNOTES_ARCHIVE_ENDPOINT / ACCESS_KEY_ID / SECRET_ACCESS_KEY` 指归档存储。`OURNOTES_ARCHIVE_SOURCE_*` 是另一套**只读**生产 checkpoint 凭据，不能复制生产写入凭据给归档。
- `sources.<region>.checkpoint.selection` 是“归档临时相对路径 → 已审核的 checkpoint 清单路径”。只读一个已固定摘要的 manifest，再 GET 选中对象并逐个验证 SHA-256/大小；最多 64 个材料，总接收最多 512 MiB。无需、也不会恢复生产工作树。
- Global 可从同一 checkpoint 的 `versionFile` 读取 `clientVersion`；JP 的 `metadata` 与相邻 `seed-manifest.json / trusted-metadata.v39.dat` 使用现有绑定校验。Global 的解码 `profile` 也必须来自同一份可信清单。
- Global 正式配置使用 `checkpoint.preset: global-production-v1`：只读取固定 `output/global-update-workflow/state.json`，从其中的生产绑定回执选择同一 manifest 内当前客户端的 metadata 与 decoder；不复制某一轮临时快照路径，不扫描目录猜测最新版本。默认三个本地材料名与示例一致。生产材料尚未更新时仍等待后续轮次。
- 离线开发可用 `materials: {"临时相对路径": "/本地只读文件"}` 替代 checkpoint。程序先复制至自己的临时目录，不能指向共享可写生产缓存。
- 可选 `packages` 为 `[{"file":"临时 APK 路径", "name":"显示名", "sha256":"已审核摘要"}]`，并配置 `apksig` 指向选入的已固定验证工具。版本、包名、签名和分包一致性通过后才生成包内清单；比较身份使用稳定的 split 名与包内路径。获取并展开有上限；不因补存请求自动下载完整历史 APK。

首次见到每个来源只建立基线，不下载全量已有内容。普通后续新增/修改自动保存。客户端材料尚未就绪时记录待取得；下一次使用新的可信 checkpoint 重试，不要求生产提前持久化或等待归档。客户端条目不可用不会阻断已经可验证的热资源/Master。客户端版本 RPC 本身要求升级时，本轮明确 `waiting_client`，不拿缓存冒充当前。

原件保存与解包独立。解码上下文在有剩余额度且版本匹配时复制到归档，并计量；缺失时保留原件，预览明确不可用。普通图片、文本、JSON、Unity 纹理/TextAsset/AudioClip、WAV 已接入；其他普通音频通过 `ffmpeg` 转为可试听格式，归档依赖自带固定版本的备用二进制，不依赖 runner 预装。ACB/AWB 还需 `vgmstream-cli` 和授权 CRI key。转换器缺失/格式不支持时提供元信息与原件下载。Master 解密使用现有私密环境引用；不把明文密钥写入清单。

Bundle 转换在隔离子进程中离线进行，逐对象隔离失败：二进制 TextAsset 或某个不支持的音频不会丢弃同包其他预览。扫描素材与清单显示分别限额，避免纹理排在大量 Transform 后被遗漏。图片缩略图最长边 2048 像素，文本最多 512 KiB，试听最多 180 秒；单轮、单文件输出均有上限，超出时明确显示截断或警告。没有内嵌媒体的预制体可只显示结构清单，不自动镜像其他 bundle 依赖。

工作台列表显示图片、文本、音频数量或待处理状态；点击文件后可直接看图、展开纯文本、操作原生试听控件，原件保留附件下载。结构清单按需展开。归档请求等待上限为 45 秒，其他工作台 API 保持 12 秒；超时显示可重试的中文提示。空间栏区分实际资源与预览、固定控制预留和总额度。

## 容量、请求与恢复

- 固定双服合计 2 GiB，其中 64 MiB 控制预留；数据对象、上下文、预览和未完成上传共同记账。单份控制账本实际存储最多 24 MiB，换代双份仍在预留内。超过 1 MiB 的账本使用 gzip 压缩，解压上限 128 MiB，兼容旧明文账本；真实双服初始目录约 20 MiB，压缩避免大版本待选条目挤满原限制。
- 逻辑到期为首次发现后 10 × 24 小时。读取立即拒绝过期项；物理删除仅在下一次既有归档任务执行，没有新增 timer。
- 原件在独立 runner 下载校验后再申请空间。先处理已确认清理与过期项，空间不足按跨服首次入库时间 FIFO。删除未确认不释放额度；预览不会踢掉原件。
- 任务每轮最多 20 分钟，接收预算最多 2 GiB，包含 checkpoint、目录、有限重试和上传读回；预算记账采用保守上界。新批次与旧待办分别分配预算/时间，最后处理预览。暂错最多本轮重试一次，失败条目自动跨轮最多三次；协议/认证拒绝不重试。
- “仅记录”与“手动选择”不会停止生命周期维护。大版本/过大单元的待选资格不会因恢复自动模式而被隐含批准。
- 清理冻结具体选择并确认后排队。页面显示预计释放与实际释放；已关闭所有归档任务时，请求没有自动执行时点。删除/FIFO/到期墓碑阻止自动补回；补存必须显式选择且不延长原来的十天窗口。
- 同一内容的再次入库使用新的对象代号，防止迟到删除影响新保存；失败上传继续占用预留。旧上传至少等待 30 分钟加 2 分钟传输宽限，再验证恢复/回收。预览及解码材料按一批预留、一批提交，复用相同摘要并沿用引用计数；清理或到期不能被迟到预览重新激活。原件读取租约最长 300 秒，单次响应在 290 秒内停止读。
- 工作台文件/预览/文本差异/导出均经过既有认证。原件附件下载；预览媒体只在同源展示，脚本文本经 `textContent` 显示。ZIP 导出为有界临时 spool，最大 128 MiB，不进行即时官方下载。

## 独立上线与验收

工作流只追加独立 `archive` job：没有 `needs: produce`，GitHub 托管 runner、`content-archive-<region>` 锁，自己的环境和凭据。原 `produce` job 保持逐字一致，cron 仍只有 `0 1,6,11 * * *`。

上线需具备对应授权并完成：

1. 核对账户并发/网络/存储请求余量，确保两服原生产容量优先；没有余量就保持关闭。
2. 审核真实清单路径和两服材料，实际验证归档桶条件写入、只读源权限、共享账本与保留策略；本地替身通过不能代替真实 R2 验收。
3. 准备独立 `content-archive-production` 环境；只使用一个 `CONTENT_ARCHIVE_CONFIG` Secret 供双服任务读取。还需各存储 Secret、必要的解码引用，以及 JP 如需的 `OURNOTES_JP_PROXY_NODE`（沿用已验证的节点包装器，仅版本端点经过代理）或 `OURNOTES_JP_VERSION_PROXY`。
4. 确认依赖交付，包括管理服务新静态模块和 boto3；Python 运行时包不包含静态资源，不能替代工作台页面交付验证。
5. 默认保持 `CONTENT_ARCHIVE_ENABLED_GLOBAL / JP` 未设置或 `false`。获授权后才逐服配置外置 `enabled: true` 并开启对应变量。
6. 原生产指纹覆盖整个工作流文件，首次接入可能触发一次原机制要求的完整生产；不得绕过门禁。核对后续三个自然时点的生产回执、公开指针和归档回执。
7. 回退只关闭两服归档变量；不要取消整个工作流或回退生产数据。验证原生产仍运行、归档停止新工作，并如实提示此时不会自动物理清理。

实际回执和必要恢复材料保存于仓库外；普通改动通过 Git 追溯。

管理服务原有按 UID 限制的出站防火墙不能直接开放互联网。正式接入通过 `ournotes-archive-egress.service.example` 的无凭据回环 CONNECT relay：仅允许一个配置的 R2 账户域名的 TLS 443。管理服务只增加到回环 18085 的权限，并配置 `HTTPS_PROXY` 与回环 `NO_PROXY`；relay 不接收存储密钥，S3 签名和 TLS 仍由管理服务 SDK 完成。SDK 闭包见 `admin/archive-requirements.txt`，单独只读挂载，不更换原生产更新镜像。

归档控制账本请求在独立入口内串行准入，防止工作台并行刷新多份大账本；其他工作台 API 不等待该准入锁。小预览使用已提交、未过期的不可变快照，校验对象身份或摘要，不为每次看图／读文本写整份账本；媒体流取得快照后释放元数据准入，并单独限制为最多四路。原件继续使用读租约保护。上线时应以真实双服基线和大版本待选清单测量管理容器峰值，再调整该容器内存上限；不能沿用仅展示统计时的 96 MiB 上限。
