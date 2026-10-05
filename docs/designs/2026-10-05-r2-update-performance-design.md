# R2 日常更新性能改造

## 问题与目标

2026-10-05 的影子迁移确认：Global 在生产前恢复私有状态耗时约 14 分钟；公共发布逐文件上传和完整读回，旧 JP 样本约 294 个对象/分钟。当前新 release 会复制未变化媒体，promote 又逐文件完整读回。以上观测不能用作网站纯代码构建的计时。

目标按工作量验收，而不提前承诺尚未实测的分钟数：

- 无游戏版本、生产代码、镜像或输入变化：不恢复历史资源、不运行生产、不上传媒体。
- 游戏少量更新：只传新增媒体内容；已有媒体通过既有校验记录与当前远端对象身份复用。
- 纯展示代码变化：沿用代码发布与现有内容预渲染路径，不进入游戏资源生产。
- 保留旧链接、Live2D 相对资源路径、旧发布及回退；正在运行的迁移继续使用原协议。

## 方案选择

1. **推荐：恢复前轻量探测 + 共享媒体物理存储。** 增加小型控制记录及兼容读取层，减少传输对象数和字节数。
2. 只提高并发：修改少，但每次仍传整套数据，放大 API 请求和网络负载，不能满足目标。
3. 更换常驻 runner：可保留磁盘缓存，但偏离已选择的 GitHub 托管 runner，增加维护任务，暂不采用。

## A. 恢复前探测

成功生产后，在私有 checkpoint 内记录经真实客户端校验的输入库存摘要。下次只读取私有 pointer、manifest、state.json 与探测需要的小型可信输入，验证记录仍绑定这些文件以及当前代码、镜像和公开发布。

在已固定镜像内调用官方版本接口；Global 同时验证官方包身份没有变化，JP 使用已审查 metadata 和现有固定日本代理。任何旧格式、缺失记录、输入/包/版本变化均回到完整恢复；损坏或探测错误绝不能被当作无更新。最后重读公有和私有指针避免竞态。

## B. 媒体复用

逻辑发布保持 `/content/releases/<id>/...`。locale JSON 和顶层 manifest 仍直接存储；public 下所有文件（包括 Live2D model/motion JSON）存到 `content/blobs/<sha256>`。Live2D model JSON 中相对 URL 继续按原逻辑路径请求，Worker 内部读取 blob，不能 redirect 到物理 URL。

每个 release 有仅内部可读的 storage descriptor 和 16 个以内的映射分片（逻辑路径 SHA256 首位分片），记录文件 SHA256、长度、MIME、完整读回后的 ETag。descriptor 绑定 manifest SHA 与完整逻辑 inventory SHA；所有媒体、分片完成验证后才写 descriptor，最后写内容 manifest。

第一次上传新 blob 必须完整读回 SHA256。后续复用必须从已完成 descriptor 获取验证记录，并以 R2 ListObjectsV2 当前的 key、长度、ETag 核对；ETag 仅作为既有校验后的对象身份，不能取代首次 SHA256 验证。不存在/身份变化时重新读回或失败，不能只相信元数据。promote 也使用相同校验目录及远端存在性检查，不能重新对所有未变化媒体下载全量正文。

Worker 仅从已允许的逻辑路径进入，内部 descriptor/shards/blobs 路径不可直接公开。缓存有大小和条目上限；descriptor 与分片必须校验绑定。保留 GET/HEAD、音频 Range、Content-Type、ETag、immutable cache。无 descriptor 的旧发布照旧读取。

预渲染 S3 reader 支持同样的媒体解析；从已验证 manifest 取得必须文件的 SHA/长度，省略重复 HEAD，仅可选美术做 HEAD；最多 8 个并行下载，读取和落盘后仍校验 SHA256，全部完成才切指针。上传新协议通过显式开关启用，必须先完成 Worker 和预渲染兼容部署，再启用生产；现有影子任务及旧 release 不改写、不删除。

## C. 边界与实施顺序

1. 实现并测试 A，工作流接入但保持所有定时/自动 promotion 关闭。
2. 实现并测试 B：新/旧读取、Range、跨 release 重用、损坏、缺失、并发条件写入、promote。
3. 增加阶段耗时与对象计数，stderr 输出进度，stdout 保持机器可读 JSON。
4. PR + verify 后在真实 runner 验收；新轻量 receipt 需要成功生产并正式发布一次才能有无变化基线。
5. 根据实测再缩小过宽的生产代码指纹；不能靠遗漏依赖获得虚假的加速。

## 验收

- 无变化轻量流程无历史资源 GET，旧 receipt 自动走完整路径。
- 同一媒体跨 release 不重复 PUT、不完整 GET；远端缺失/ETag 变化不可静默跳过。
- 单个新增媒体只有该媒体需要正文传输，其余为有限控制分片/List 请求。
- Worker 旧 release 可用；新 release 二进制 GET/HEAD/Range 和 Live2D 相对请求字节一致。
- 未完成上传或索引校验失败绝不推进 current；当前站点保持原样。

R2 S3/List 支持和一致性参考：
https://developers.cloudflare.com/r2/api/s3/api/
https://developers.cloudflare.com/r2/reference/consistency/

## 本地旧快照规模核对

JP 共 22,689 个文件，其中约 15,013 个是 public/live2d JSON；它们也可以透明映射到共享对象。因此共享范围必须覆盖全部 public/，不能只覆盖二进制。约 2 千多个 locale 数据文件仍按 release 重建；其数量和剩余生产/恢复耗时须继续实测，不能宣称整个更新已达到分钟级。
