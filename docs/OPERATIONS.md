# 运行维护

实际部署地址、配置值、账号和原始运行报告保存在仓库外。公开报告只列状态、错误分类与必要产物身份。

## 状态与配置

网站 HTTP 成功、任务成功和数据新鲜度分别验收。定时器启用不代表任务成功；接口返回 `stale` 时不能宣称数据最新。检查最后尝试、最后成功、失败原因以及观测时间。

线上生效配置是初始行为基线。内容检查初始为每轮结束后两小时，模板不得自动覆盖它。程序发布记录提交号与包摘要，配置在受保护位置单独维护。

不可变程序迁移保留已有容器根、工作目录和历史状态中的绝对路径；以同一次状态根挂载容纳工作输出与内容，再只读覆盖固定版本程序子目录。先在无网络、只读状态挂载中验证新程序和私有输入，成功后另行切换服务。制作备份和通过预检本身不代表线上已采用新程序。

已脱敏解包源码要求外置 Master 三项 32 字节十六进制材料和非零 CRI 密钥。材料只存在于受限 env 文件，通过容器 `--env-file` 加载；不显示其值、导入真实配置到仓库或把材料重新写回程序。解密材料检查与依赖检查均完成后，才允许正式内容任务。渲染器不挂载这些材料。

## 独立磁盘维护

更新器在低于私有配置空间门槛时保留线上内容并退出。维护不能依赖更新成功后才执行。硬链接存在时，不可简单相加各目录的占用。

`tools.operations` 对已完成预渲染中的不可变 JSON 载荷提供无损去重：验证 SHA-256 文件名、实际字节、文件系统、所有者、权限、扩展属性和标志，再把相同内容改为硬链接。所有历史 URL、版本与字节保持不变，不删除快照、不缩短浏览器保留期。

```sh
python3 tools/operations.py dedupe-plan --rendered-root /PRIVATE_RENDER_STORE --plan /PRIVATE_DIRECTORY/dedupe-plan.json
python3 tools/operations.py dedupe-apply --rendered-root /PRIVATE_RENDER_STORE --plan /PRIVATE_DIRECTORY/dedupe-plan.json
```

计划文件权限为 `0600`，终端只输出汇总。执行前取得渲染器使用的锁，重新核对库存和完整计划。损坏摘要、符号链接、无效回执或库存变化均拒绝操作。中途失败保留所有字节，重新生成计划后可继续。

历史代码包也可无损去重，将上述 `--rendered-root` 换为 `--code-root /PRIVATE_CODE_STORE`。工具验证每个版本的完整文件清单、代码身份和入口 HTML，只合并相同编译文件；回执、入口及 current/previous 指针保持不变，并使用代码发布锁。

遇到历史目录不符合清单时先停止并检查原因。如需保留整个目录，可在计划和执行命令中都明确传入 `--exclude-code-id REVIEWED_CODE_ID`（可重复）。排除集合写入计划，执行时必须一致；指定版本完全不访问、不修改，其余版本仍执行完整校验。不能通过排除来宣称该版本已通过验证。

内容快照使用独立入口，与内容发布共用 `.publication.lock`：

```sh
python3 tools/operations.py dedupe-plan --content-root /PRIVATE_CONTENT_STORE --plan /PRIVATE_DIRECTORY/content-plan.json
python3 tools/operations.py dedupe-apply --content-root /PRIVATE_CONTENT_STORE --plan /PRIVATE_DIRECTORY/content-plan.json
```

该入口逐一验证回执库存、实际文件摘要、manifest 身份和区域指针绑定，保护所有清单和指针。Linux 文件标志通过文件系统接口读取，不能以缺少 `st_flags` 推定没有标志。只选择全部硬链接均在审查范围内、确实能够释放空间的目标 inode；保留外部仍被引用的 inode。计划后库存、元数据或链接数变化即拒绝继续。

硬链接合并会改变 inode、ctime 和链接数，目标文件会继承保留文件的 mtime；保留的是内容、URL、权限及扩展属性，并非所有元数据。中途 I/O 失败可能已经完成部分无损合并，应重新生成计划，不能强行重试旧计划。

维护前确认内容任务空闲并安排发布静默窗口；完整库存检查会持有发布锁。实际配置中的根目录与计划位置均在仓库之外，不能把上述占位值直接用于生产。

估计回收量会受其他硬链接及并发磁盘写入影响，执行后重新检查空间。不可变文件只能新建并切换，不得原地覆盖；去重不能代替长期容量规划。

原始下载缓存与内容快照使用不同回执和锁，不能把缓存目录传给 `--content-root`。对缓存做维护前还必须验证获取回执、所有路径的实际摘要、文件属性与全部硬链接引用，并确认写入端采用临时文件加原子替换；即使回执丢失的恢复路径，也不能原地覆盖共享 inode。个别现场维护计划不构成任意缓存目录的通用清理授权。

候选编译的媒体隔离也必须保留：候选在封存前解除 `public/media` 与可变输入之间的硬链接，保证后续输入变化不改写已验收候选。不能为了省空间取消这一步，或把封存媒体重新链接到 input、partial、cache 的 inode。跨候选/内容媒体的专项维护只允许已封存、完整回执绑定的文件；保留文件和替换文件的全部硬链接都必须落在已审查的不可变媒体范围内。

## 回收与恢复

`tools.render_retention` 提供独立的历史 HTML 归档与回收。只选择超过保留年龄且不被两服 current/previous 或 pending 引用的地区 HTML 目录；所有 `payloads`、发布回执和内容/代码快照保持原位。默认保留七天，工具拒绝小于一天的窗口。维护同时取得 `.r2-prerender.lock` 与 `.render.lock`；正在发布时退出，不停止网站。

```sh
python3 -m tools.render_retention plan --root /PRIVATE_RENDER_STORE --plan /PRIVATE_DIRECTORY/html-plan.json
python3 -m tools.render_retention archive --root /PRIVATE_RENDER_STORE --plan /PRIVATE_DIRECTORY/html-plan.json --archive /PRIVATE_ARCHIVES/html.tar.gz
python3 -m tools.render_retention apply --root /PRIVATE_RENDER_STORE --plan /PRIVATE_DIRECTORY/html-plan.json --archive /PRIVATE_ARCHIVES/html.tar.gz
```

归档必须位于渲染目录之外。压缩文件限制在 512 MiB 内，并为所在文件系统预留至少 2 GiB；超限/失败只清除本次未完成归档，不回收 HTML。执行前重做库存并逐文件验证归档摘要，指针或文件变化要求重新生成方案。计划和归档权限为 `0600`。实际释放量按执行前后空闲空间核对，硬链接按 inode 计算，不重复累计。

先安装支持历史 HTML 重新生成的 `deploy/promote_r2_prerender.py` 版本，再启用回收。旧代码/内容重新成为当前版本时，预渲染器可恢复 HTML，同时保留旧浏览器载荷。离线恢复也可由管理员先验证归档，再将计划内 HTML 还原到原路径；不要解压未知归档或覆盖当前视图。

定时维护模板见 `deploy/ournotes-render-maintenance.*.example` 和 `deploy/run-render-maintenance.sh`，程序目录必须固定到已验证版本，三个目录环境变量保存在私有配置中。`RENDER_MAINTENANCE_AGE_DAYS` 可按实际容量指定 1–30 天，默认七天；缩短窗口仍保留 current/previous/pending 和全部载荷。首次人工核对方案及归档后再启用。默认每批最多回收八个视图，后续周期继续处理；较大的页面集合可显式进一步降低 `--max-views`，不能绕过压缩预算。压缩归档仍占空间且不会自动删除，应监控归档目录容量并另行制定备份保留策略；归档预算失败不能被视为清理成功。安全拒绝返回固定错误码，可区分发布锁忙、计划变化和归档预算超限。

内容生产模式的更新器和预渲染发布器不再在发布成功后自动删除历史版本、输入或 HTML。发布结果明确报告 `retention.status = deferred_to_operations`；保留成功记录和版本历史不代表已回收空间。失败产生且未发布的临时目录仍由对应任务清理。

这样可以独立审查删除范围，避免旧的零等待期回收只检查内容指针却遗漏预渲染和已打开页面。空间不足时仍执行原有门槛检查并保留当前内容，不降低门槛、不通过删除未审查数据来完成更新。旧完整静态站维护路径不属于新版内容生产入口。

删除型回收必须保护 current/previous、两服交叉引用、预渲染引用、浏览器保留期与输入基线。未知目录不清理；先给出具体对象、引用检查、释放估计及恢复来源，不执行全局 prune 或整目录删除。

上游错误不转换为空成功。兼容性诊断先使用最小、无账号的只读探测，输出固定错误分类，再通过已有任务完成有限的真实验收。凭据和原始 RPC 响应不得进入日志或仓库。
