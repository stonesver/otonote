# Actions + R2 内容迁移操作手册

目标：Global、JP 的内容生产在 GitHub 托管 runner 运行；现有服务器继续提供网页与其他服务。`ournotes.stonebg.cn/content/*` 在验收后由只读 Worker 从 R2 提供。本文是配置与验收步骤，不代表 R2 已完成真实上传或站点已切换。

## 两个 bucket 的用途

| Bucket | 用途 | 对访客开放 | 建桶建议 |
| --- | --- | --- | --- |
| `otonote-production-state` | APK、生产输入、缓存、私有配置、跨 runner 检查点 | 绝不开放 | 自动位置、标准存储类；不必为 JP 选择日本位置 |
| `otonote-public-content` | 经封存的 `/content/releases/...`、Global/JP 指针 | Bucket 本身保持私有；仅经只读 Worker 公开允许的路径 | 自动位置、标准存储类 |

**私有状态桶为什么需要：** GitHub 托管 runner 每次都是新机器；Global 的历史 `state.json`、下载输入和候选回执含固定绝对路径，JP 也要保留受信任客户端输入。`tools.r2_state` 把明确选中的目录按 SHA-256 存为不可变对象，再用区服独立指针记录可恢复的状态。没有它，每次要重新采集全部输入，也无法安全复用已校验的基线。它不是社区数据库，也不供浏览器访问。当前实现按所选目录完整检查点，首期必须实测传输量与 runner 磁盘峰值；后续才能按内容身份缩小工作集。

Cloudflare 的位置提示用于预期主要访问地域，是尽力而为的优化，不按 Global/JP 游戏区服划分。当前代码使用默认 R2 S3 endpoint，因此两个桶都应使用普通 `Automatic` 位置，而非有专用 endpoint 的司法辖区限定。标准存储类适合频繁读写的生产状态和站点媒体。[R2 位置说明](https://developers.cloudflare.com/r2/reference/data-location/) · [存储类](https://developers.cloudflare.com/r2/buckets/storage-classes/) · [辖区 endpoint](https://developers.cloudflare.com/r2/api/tokens/)

## 启用前提供的外部配置

1. 在 Cloudflare R2 建好上述两个桶，均不要开启公开 bucket URL、`r2.dev` 或自定义公开域名。现有橙云代理主机名已足够，**不需要再建资源子域名**。
2. 在 R2 管理页创建 **Object Read & Write** S3 API 凭据，只授权这两个桶。记录 Account ID、Access Key ID、Secret Access Key；密钥放 GitHub Environment，勿贴进聊天、仓库、工作流变量或日志。当前两套 Python 客户端共用一组凭据和默认 endpoint，故两个桶须在同一 Cloudflare 账户普通辖区。[R2 凭据步骤](https://developers.cloudflare.com/r2/api/tokens/)
3. GitHub 仓库已创建 `content-r2-production` Environment，并把 deployment branches 限为 `main`；下方六个非敏感变量也已创建且两服开关均为 `false`。尚需在该 Environment 下设置 Secrets：`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`OURNOTES_CRI_KEY`、`OURNOTES_MASTER_SALT_HEX`、`OURNOTES_MASTER_KEY_HEX`、`OURNOTES_MASTER_IV_HEX`。后三个 Master 值必须各为 32 字节的十六进制字符串；CRI key 必须是非零整数。仓库 `main` 当前尚未启用分支保护，应在合并前设置。工作流另检查 `github.ref`，PR 不运行生产 job。环境保护和环境 Secrets 的行为见 [GitHub 文档](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)。
4. 准备现有 Global 更新器使用的**真实私有配置与生产镜像**。已只读确认服务器上的本地镜像是 `ournotes-global-update:20260928-v1`，但它的 `RepoDigests` 为空，不能作为 GitHub runner 可拉取的地址；`global-update.service` 当前为 `failed`、退出码 1，不能把旧服务健康视为迁移成功。仓库 `deploy/Dockerfile.global-update` 现固定为服务器已持有、可匿名读取清单的 Aliyun 基础镜像摘要。服务器构建目录中的 vgmstream 归档属于官方提交 `7dc938fa2f210943b37c7b6511852b516ef432ab`，其 SHA-256 与官方归档下载一致。合并后可手动运行 `.github/workflows/publish-update-image.yml`，它复现镜像、离线检查必要工具，以 `GITHUB_TOKEN` 推送到 GHCR，并在 run summary 给出 `仓库@sha256:<64 hex>`。**审核构建日志与摘要后**将该值填入 `OURNOTES_UPDATE_IMAGE` 仓库 Variable；不使用服务器本地标签。GitHub [容器镜像发布说明](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images) 和 [包访问权限说明](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)可用于核对。若 GHCR 包未自动授予本仓库读取权，在该包的 **Manage Actions access** 中授予本仓库读取权，不要直接把镜像设为公开。镜像不存在或权限不足时内容任务会在产出前失败。
5. Global 私有配置已定位在本机 `~/Documents/data/otonote/private/local-configuration/config/global-update.server.json`，服务器另有 `/srv/ournotes-updater/app/config/global-update.server.json`。它的 `contentPublication.root` 仍指向服务器旧内容目录。为保留旧服务的回退配置，在稳定根复制成独立的 `config/global-update.r2.json`，仅将 `contentPublication.root` 改为 `/srv/ournotes-updater/app/output/r2-global-content`，并确认没有整站 `publication`；不要修改旧配置。仓库 Variable `R2_GLOBAL_CONFIG_PATH` 设为 `config/global-update.r2.json`。该私有文件只进入私有状态桶，不提交到 Git。可选的 `R2_GLOBAL_DECODER_PROFILE_PATH` 是同一根下的相对路径；若需要 profile，须列入私有检查点。Global 的 APK 签名工具、decoder profile、baseline、input plan、initial observation/package 与私有工作目录均要在恢复后存在；公开内容库由本次任务在独立目录重新封存并上传，不列入私有检查点。`R2_GLOBAL_STATE_PATHS` 必须与首次检查点的 `--path` 完全一致；已确认旧配置引用了 `output/global-update-workflow`、`output/verification/global-remote-20260927`、`output/formal-inputs/global-current-complete-104-v4` 和 `runtime/apksig-9.4.1.jar`。若配置中的路径后续变化，先更新清单并重新做恢复演练。
6. JP 首期检查点固定为 `output/r2-jp`，需包含二进制 `metadata.v39.dat`、`unity-version.txt`、`apks/`，以及后续 `workspace/`。公开内容的本地封存目录为独立的 `output/r2-jp-content`，不进入私有检查点。本机 `~/Documents/data/otonote/resources/input/jp/` 中的 1.0.4 三个 split APK、元数据及 Unity 身份已通过 `tools.prepare_jp_r2_seed` 验证；工具固定了签名证书 SHA-256 `34fd32c2860f454dd320930f6ba0876ea8cc8e60a3d8320b3277aa761072508e` 与整套 APK 的摘要 `b50122ad3e56a8afc64f6fb77e06cbf29240adcf83783ba602af74a32369b28c`。将这些源文件安全复制到受控机器后，在稳定根执行下方命令，避免复制约 4.6 GB 的整份手机缓存。新客户端版本或未知解码映射必须阻断。不能把未知网上 APK 自动设为可信输入。当前已用固定 1.0.4 本地元数据对官方入口作只读探测，返回 HTTP 403；这是未满足的真实环境关口，尚无 JP 无人值守成功证据。403 未解决前，JP job 应失败并保持公开指针不变。

### 私有状态首次导入

在可访问真实输入的受控机器上，先将程序及选定的私有文件布置到**同一绝对根** `/srv/ournotes-updater/app`，与 Actions 中完全一致；不能只复制旧 `state.json` 而保留失效的路径。`tools.r2_state` 的清单记录 `root` 和精确的路径选择，恢复时会校验两者。服务器现有 Global 工作目录约 13 GB，其中 `sync-complete` 约 6.7 GB、`builds` 约 2.8 GB。工作流恢复前先读取清单大小，并要求在清单总字节数之外仍有 8 GiB 空闲；标准 runner 是否够用必须以真实检查为准，容量不足时改用更大 GitHub 托管 runner。为每服分别运行下面的命令；`--path` 必须与之后工作流使用的路径列表一模一样。

JP 可先运行 `python3 -m tools.prepare_jp_r2_seed --metadata <已复制的global-metadata.v39.dat> --apk-root <已复制的三份split-APK目录> --unity-version-file <已复制的unity.ver> --output /srv/ournotes-updater/app/output/r2-jp`。目标目录必须预先不存在；工具会校验 1.0.4 版本、签名证书指纹、整套 APK 摘要和元数据摘要，并产生 `seed-manifest.json`。上述源文件留在受控机器，私有桶只存检查点，不向公开桶复制。随后运行下方 JP `checkpoint`。

Global 在服务器稳定根内准备独立配置，保留原文件作为回退：

```bash
cd /srv/ournotes-updater/app
cp config/global-update.server.json config/global-update.r2.json
python3 - <<'PY'
import json
from pathlib import Path
p = Path('config/global-update.r2.json')
config = json.loads(p.read_text())
assert isinstance(config.get('contentPublication'), dict) and not config.get('publication')
config['contentPublication']['root'] = '/srv/ournotes-updater/app/output/r2-global-content'
p.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
PY
```

```bash
cd /srv/ournotes-updater/app
python3 -m pip install -r tools/r2-requirements.txt
# 先在环境中设置 R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY、R2_PRIVATE_BUCKET。
python3 -m tools.r2_state current --root /srv/ournotes-updater/app --region global
python3 -m tools.r2_state checkpoint --root /srv/ournotes-updater/app --region global \
  --expected-current none --path config/global-update.r2.json \
  --path output/global-update-workflow \
  --path output/verification/global-remote-20260927 \
  --path output/formal-inputs/global-current-complete-104-v4 \
  --path runtime/apksig-9.4.1.jar
python3 -m tools.r2_state checkpoint --root /srv/ournotes-updater/app --region jp \
  --expected-current none --path output/r2-jp
```

Global 仓库 Variable `R2_GLOBAL_STATE_PATHS` 对应上方五条路径的 JSON 数组。若 `current` 已有指针，必须先审查旧清单，使用返回的 `currentSha256` 作为 `--expected-current`，不要覆盖现有状态。首次导入后应在另一干净目录的相同绝对根做恢复演练；恢复要求目标文件不存在，不能覆盖本地文件。可先用 `python3 -m tools.r2_state inspect --root /srv/ournotes-updater/app --region global` 加上相同的五个 `--path`，只读取得清单总字节数。

## 工作流门禁与日常运行

镜像发布先于任何内容生产。合并草稿 PR 并检查默认分支后，在 Actions 手动运行 **Publish reviewed updater image**；审查日志中的源归档摘要、基础镜像、工具检查与 GHCR digest，并将 summary 给出的完整 `ghcr.io/...@sha256:...` 写入 `OURNOTES_UPDATE_IMAGE`。发布工作流只允许默认分支执行，使用该仓库的 `GITHUB_TOKEN`，不需要在聊天里传递镜像仓库密码。内容工作流使用 `packages: read` 的 `GITHUB_TOKEN` 登录同一 GHCR 包，按固定摘要拉取。

`.github/workflows/content-r2.yml` 两服各每四小时运行一次，UTC 错峰；GitHub `schedule` 可能延迟或丢弃，须人工核查最后成功时间。相同区服 `concurrency` 串行且不取消正在运行的生产；两服独立。工作流仅在受保护默认分支启动。

启用前在仓库 Variables 设置：

| 名称 | 值 |
| --- | --- |
| `OURNOTES_UPDATE_IMAGE` | 已验证存在的生产镜像，必须固定 `@sha256:` 摘要 |
| `R2_GLOBAL_CONFIG_PATH` | 私有配置的根相对路径 |
| `R2_GLOBAL_STATE_PATHS` | 精确恢复路径的 JSON 数组 |
| `R2_GLOBAL_DECODER_PROFILE_PATH` | 可选，Global 私有 decoder profile 的根相对路径 |
| `CONTENT_R2_ENABLED_GLOBAL` / `CONTENT_R2_ENABLED_JP` | 分服设为 `true` 才允许运行；缺省关闭 |
| `CONTENT_R2_AUTO_PROMOTE_GLOBAL` / `CONTENT_R2_AUTO_PROMOTE_JP` | 经影子验收后设为 `true`，此前定时任务只上传不可变内容，不切公开指针 |

工作流手动 `Run workflow` 可选 `global` 或 `jp`，以及 `shadow` 或 `promote`。**先使用 shadow**：从私有状态恢复，执行生产，上传并读回公开不可变对象，写回私有检查点；R2 `content/current.json` 或 `content/jp/current.json` 不变。Actions run 本身是最后尝试记录；私有 `state/<region>/current.json` 是最后可恢复的生产检查点；公开 `content/promotions/<region>/...` 与对应 `current.json` 记录已晋级内容。失败时停在当前步骤，公开指针不变。私有检查点在公开晋级前提交，因此晋级失败时它可能比公开指针新；重跑会按公开指针基线再次校验并尝试晋级。

只检查本地封存包而不连接 R2 时，可运行 `python3 -m tools.r2_content upload --region global --store <内容库> --dry-run`；公开对象已影子上传后，可用 `promote --dry-run` 搭配 `--expected-current` 和 `--source-run` 复核远端完整性及指针基线，不执行切换。

影子 run 至少检查：真实 runner 空间峰值、完整耗时、官方版本身份、客户端签名和解码校验、Global/JP 候选与封存回执、R2 读回摘要、两服交叉引用和现有网页预渲染。`ubuntu-latest` 的资源规格会因仓库类型变化，不要只按名义磁盘值判断；实际以 `df` 和 run 记录为准。[GitHub 托管 runner 规格](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

## 现有域名的只读 Worker Route

仓库提供 `deploy/r2_content_gateway.mjs` 和 `deploy/r2-content-gateway.wrangler.example.json`。在控制台选择 **Start with Hello World**，名称 `ournotes-content-gateway`，创建后将 `worker.js` 全部替换为网关代码。Worker 的 R2 变量名必须为 `CONTENT`，绑定 **`otonote-public-content`**；绝不绑定私有状态桶。先在其 `workers.dev` 测试地址验证允许的 GET/HEAD 和拒绝的私有路径；在真实快照可读且浏览器验收之前，不添加线上 Route。空桶时 `/content/current.json` 返回 404 是预期结果。

现有服务器预渲染前，使用单独的 **仅可读取公开桶对象** 的 R2 API 凭据运行 `python3 -m tools.materialize_r2_content --store <现有本地内容库> --region all`。该命令只物化两服清单、清单引用的数据文件、画廊清单和两张加载图；普通媒体继续留在 R2。它会在校验后才更新本地指针，然后沿用现有 `tools.publish_prerender`。服务器凭据不要复用 Actions 的写入密钥。

切换时，在 Cloudflare 控制台进入 **Workers & Pages → 选择该 Worker → Settings → Domains & Routes → Add → Route**，选择 `stonebg.cn` zone，填写 `ournotes.stonebg.cn/content/*`，保存。`ournotes.stonebg.cn` 现有橙云 DNS 记录已满足 Route 前提。该 Route 仅接管 `/content/*`；网页与其他路径继续走现有源站。Cloudflare [Route 官方步骤](https://developers.cloudflare.com/workers/configuration/routing/routes/)和 [R2 Worker binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)可对照操作。

Route 切换后检查：`/content/current.json`、`/content/jp/current.json` 返回新旧预期摘要且 `Cache-Control: no-store`；两服 manifest、JSON、图片、音频、Live2D 均可读；隐藏文件、APK、列目录和写入请求被拒绝；四个语言入口、跨服引用、预渲染与动态服务正常。旧 Nginx 内容库和位置配置在切换期保留。

## 故障和回退

- 生产失败或 R2 校验失败：保持 `CONTENT_R2_AUTO_PROMOTE_*` 关闭或设回 `false`；检查 Actions 失败步骤、私有检查点、公开晋级记录。不要删除旧 release。
- Worker Route 故障：在上述 **Domains & Routes** 删除 `ournotes.stonebg.cn/content/*` Route，流量立即回到保留的旧 Nginx `/content/` 路径；先验证旧内容仍完整，再操作。
- 公开内容需要回退：先运行 `python3 -m tools.r2_content baseline --region global`（JP 改为 `jp`）取得 `currentSha256`，检查返回的 `previousPointer` 是否指向所需旧版本，再运行 `python3 -m tools.r2_content rollback --region global --expected-current <currentSha256> --source-run <工单标识>`。命令验证旧清单及所引用的 JSON 后写晋级记录，并用条件写切回旧指针；普通媒体的完整性仍须在 Worker 测试地址抽验。不要在控制台直接手改 `current.json`。紧急情况下优先撤 Route 回到原站内容。
- 新流水线通过真实定时运行、Route 和浏览器验收后，才停止服务器旧的 `global-update.timer`。保留旧源站内容和旧 HTML 引用；历史对象清理仍由独立引用审计决定，不由工作流自动删除。
