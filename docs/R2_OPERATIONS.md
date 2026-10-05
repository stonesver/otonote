# Actions + R2 内容迁移操作手册

目标：Global、JP 的内容生产在 GitHub 托管 runner 运行；现有服务器继续提供网页与其他服务。`ournotes.stonebg.cn/content/*` 在验收后由只读 Worker 从 R2 提供。本文是配置与验收步骤，不代表 R2 已完成真实上传或站点已切换。

## 2026-10-05 实际迁移验证

- [托管 runner 容量探测](https://github.com/stonesver/otonote/actions/runs/37245094874) 已通过：两个 bucket 可读/列举，固定生产镜像可拉取，拉取后剩余 **90,022,023,168 字节**。Global 初始恢复估算 9,445,000,000 字节加 8 GiB 预留，要求 **18,034,934,592 字节**，符合首轮恢复门槛；生产过程的峰值仍须影子运行实测。
- JP 首次私有检查点已上传并逐对象回读校验，6 个文件共 **234,502,644 字节**，清单 SHA-256 为 `3c6f151cd263ac843e873ea97292d73043f3f1a8934a123f002f289b0d39d2e1`。
- Global 首次私有检查点已完成，包含 **180,058 个文件**；清单 SHA-256 为 `6e29a9abe544949ff3174200e5c0e3d7305252edfb41f216dcce9a1c6159d8a3`，指针 SHA-256 为 `bf72184535b21ef4a0a6c3acacb444fbf3f170717f96b537ea518a5f21470f59`。[首次完整恢复与影子生产](https://github.com/stonesver/otonote/actions/runs/37254003704) 在 16 分 33 秒内成功恢复全部文件，实测逻辑字节 48,101,013,923，恢复加 8 GiB 预留要求 18,034,603,998，runner 当时可用 92,321,288,192。随后客户端校验因缺少外置 bundle decoder profile 而停止，没有公开晋级。已将与两版实际客户端元数据身份匹配的可信 profile 补入第十一条私有路径；新清单 `4aaba3884cbab0c22259fb68cf0be15d3fb4a9142ddc61068b324860dfeab3d3`，指针 `ee62a31cab73a2ecb2dea5da9d2e552350f32aca5a155b9b50294c1802e2c0f4`，180,059 文件，仅上传 1 个新对象，其余逐一回读后复用。路径 Variables 已成对更新。两服定时开关均已恢复为 `false`。
- [JP 首轮影子运行](https://github.com/stonesver/otonote/actions/runs/37245779173) 已在全新 GitHub runner 成功恢复这 6 个文件、检查容量并拉取固定镜像。生产阶段官方版本 RPC 返回 **HTTP 403**；没有进入公开内容上传、私有新检查点或公开指针晋级。该结果证明首次恢复链路可用，不能视为 JP 自动追新验收。
- JP 协议解析已按受信任 1.0.4 APK 校正：`x-asset-version` 是 JSON，非空 `live` 中选择不超过当前客户端版本的最高 `minClientVersion` 对应的 Android 身份；不回退到 `history` 冒充当前版本。服务端 CDN 密码仅在官方 CDN 根精确匹配时更新到内存，观察回执不记录该值。解析修正和 25 项 JP 测试通过不代表 403 已解决；对公开正常 gRPC 请求形状的一次验证仍被拒绝，需官方客户端成功请求的脱敏证据才能继续确定入口条件。[公开协议对照](https://github.com/haneoka-gakuen/haneoka/blob/d6b214d5c785132e89169412b6e0ce8191e43a6d/scripts/ingest/version_api.py)
- 站点所有者随后报告手机日服提示更新，但实时官方商店详情仍显示 1.0.4，APK 下载页仍为 10053；未找到更高版本的证据。本机暂未连接 ADB 设备，须核对手机实际版本、提示原文与网络出口。该提示不能单独证明 RPC 403 是版本原因；出口访问策略和正常请求条件仍待确认。
- 本机 Clash 对照发现此前 Version 请求实际经美国节点返回 403；切换日本节点后，站点所有者确认手机冷启动能进入游戏，本机受信任 Version 请求也返回 HTTP 200 / gRPC 0。经明确授权，仅该日本节点写入 GitHub Environment Secret；[托管 runner 只读探测](https://github.com/stonesver/otonote/actions/runs/37252306052) 使用固定摘要的 mihomo 客户端成功取得客户端 1.0.4、Master/资源 1.0.0.350。这验证指定出口下的版本探测，不代表完整生产验收。后续 [JP 影子生产](https://github.com/stonesver/otonote/actions/runs/37253004172) 已启动，定时开关随即恢复为 `false`。
- [独立预渲染镜像构建](https://github.com/stonesver/otonote/actions/runs/37249866227) 已通过离线 Python/Node 检查和摘要回拉验证；镜像解压大小 **328,569,484 字节**，离线归档 **136,214,235 字节**。两服旧快照的预渲染子集约需 386 MB，fresh HTML stage 约需 549 MB；旧服务器尚未安装或切换新服务。
- 后续 [JP 完整影子任务](https://github.com/stonesver/otonote/actions/runs/37253004172) 在输入构建阶段因远端 bundle 缓存文件名加上回执后缀超过文件系统单段长度限制而失败；未写入新的私有检查点或切换公开指针。修复使用包含 CDN 相对路径的完整资源身份 SHA-256 作为固定长度缓存文件名，原始资源身份仍保留在回执中供严格复用校验。
- 包含未变更 HTML 复用检查的[预渲染基线镜像](https://github.com/stonesver/otonote/actions/runs/37252316947) 构建成功，源码 `f5fe7a9731fc0f6fe170cf8b75f2f66e135deb76`，仓库摘要 `sha256:b465aae7bce368b28fae19a6ed94476be59b86eb9dc8a299c01ed03000e1a8f2`，本地镜像 ID `sha256:77f12e07b6e562f63d3f471800c36c45ae07a6caf6c35d31340978065aa78c69`。归档 **136,232,406 字节**、SHA-256 `ede60df6755aafa79a17d558dee022ddeff36d90734119e215b20552dfb21788` 已在本机验证，OCI blobs 与源码标签匹配。现已流式加载到服务器，实际镜像大小 **328,584,817 字节**，ID、源码标签及隔离运行时检查通过；新服务文件和只读公开桶凭据已准备，但未启动服务或切换原触发器。
- [JP 重试](https://github.com/stonesver/otonote/actions/runs/37254773236) 已通过此前的缓存文件名故障，随后在 Spine 动画读取时失败。已定位到脚本只查找 `site/node_modules`，而固定更新器镜像将依赖安装在 `/opt/ournotes-node/node_modules`；修复保留本地优先并兼容镜像依赖，完整生产仍待再次运行验收。
- 经站点所有者明确授权，在更新器同一把 `workflow.lock` 下复核后，仅删除旧 `conversions`、`builds/story-live-drops-20260929`、`builds/ac26a51fe4c918968aa1` 三个可重建目录。实测释放 **1,793,196,032 字节**，剩余 **2,025,517,056 字节**；当前/保留版本目录仍在，`state.json` 摘要未变，`global-update.timer` 保持 active。
- 启用新 timer 前发现未变更物化仍对两服约 4,750 个 manifest 记录逐一 HEAD。已增加仅在本地保留的完整校验回执；复用路径仍验证远端 pointer/manifest 身份、manifest 记录与全部本地文件 SHA，但每轮两服只需 8 次控制 GET，无逐对象 HEAD/下载。此前已加载的基线镜像不能直接启用定时器，须先替换为包含该修复并通过验证的新镜像。
- [Global 解码配置补齐后的重试](https://github.com/stonesver/otonote/actions/runs/37257537248) 通过完整恢复、客户端解码、输入同步和预检，但 `release_candidates.py` 的 `compile-data` 阶段退出 1；没有新检查点或公开晋级。运行时仍有约 78 GB 可用，现有日志不能证明缺盘或某项依赖是根因；完整子日志仅在临时 runner 内，须增加私有诊断保留后再定位。
- 两服旧快照的私有迁移包已独立读回验收：45,507 文件、18,324 唯一对象，清单 `c9f2ff7dc0798f53f77773b68199d4c70d9ad8ef2d934e38b34004cf270b0f16`，命名空间指针 `6513858c0abbc8e7f025f631c9b67934edce48871bc1bda44ea432dc7f175052`。公开桶影子导入见 [bootstrap run](https://github.com/stonesver/otonote/actions/runs/37259448587)。本机临时 R2 DIRECT 运行时规则已恢复，用户当前代理节点选择与原配置文件保留。
- [包含本地回执复用的新预渲染镜像](https://github.com/stonesver/otonote/actions/runs/37258913286) 已验证并加载，源码 `6fab0b4ef8195d54591ba03aeb8d70b9154ea9bc`，仓库摘要 `sha256:7040a1db912c02473ed89b8e7ceab5ded52b313ef4e393a3f8a619b1dca5466c`，本地镜像 ID `sha256:b2fb671429110e86e455bc753957033809a1faf722034ab756c44767571f61f4`，实际大小 328,593,148 字节。归档 SHA `dded65a56baf0091b078b1ac54df9fc80125717b0cf91672e7a6240a73e8f716` 和 26 个 OCI blobs 均验证；新服务配置已指向它，服务和 timer 保持 inactive。
- 首轮手动任务启动后，已将 `CONTENT_R2_ENABLED_JP` 恢复为 `false`；两服自动晋级均保持关闭。旧服务器数据与定时器尚未切换。

本机首次上传使用另建的、仅授权私有状态桶的临时 S3 凭据，保存在仓库外的权限 `600` 文件中；GitHub 原有凭据继续供 Actions 使用。两服首次上传及恢复验收完成后撤销临时凭据，切勿先撤销仍供 Actions 使用的原凭据。

公开桶预渲染只读凭据也已完成实际读/列举验证，两服公开指针当时均不存在；这不是公开内容发布验收。

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
3. GitHub 仓库已创建 `content-r2-production` Environment，并把 deployment branches 限为 `main`；下方非敏感变量已创建且两服开关均为 `false`。三个 R2 Secrets 与 `OURNOTES_CRI_KEY`、`OURNOTES_MASTER_SALT_HEX`、`OURNOTES_MASTER_KEY_HEX`、`OURNOTES_MASTER_IV_HEX` 已写入该 Environment，并通过 API 核对名称。Master 参数由两服可信加密样本及历史成功报告离线验证；CRI 参数由两服视频样本、Global 音频样本验证，值不进入仓库或本文。仓库 `main` 已启用分支保护：必须通过 PR 合并、`verify` 检查通过且分支保持最新；规则也适用于管理员，禁止强推和删除。不额外要求人工审批人数。工作流另检查 `github.ref`，PR 不运行生产 job。环境保护和环境 Secrets 的行为见 [GitHub 文档](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)。
4. Global 更新器镜像已通过 [发布工作流](https://github.com/stonesver/otonote/actions/runs/37230213563) 构建、推送并按摘要拉回验证，`OURNOTES_UPDATE_IMAGE` 仓库 Variable 已指向 `ghcr.io/stonesver/otonote-update@sha256:35d734d3273c0d3db7bb47aea2a421e5192503f1caf139c52590ded29ef30828`。构建使用固定摘要的公开 Node 基础镜像和官方 vgmstream 提交 `7dc938fa2f210943b37c7b6511852b516ef432ab`，不依赖旧服务器的本地镜像标签。仍须恢复真实私有配置与输入后，在 Actions 完成影子运行；旧服务器的 `global-update.service` 当前为 `failed`、退出码 1，不能把镜像发布当成生产验收。若 GHCR 包未自动授予本仓库读取权，在该包的 **Manage Actions access** 中授予本仓库读取权，不要直接把镜像设为公开。
5. Global 私有配置已定位在本机 `~/Documents/data/otonote/private/local-configuration/config/global-update.server.json`，服务器另有 `/srv/ournotes-updater/app/config/global-update.server.json`。它的 `contentPublication.root` 仍指向服务器旧内容目录。为保留旧服务的回退配置，在本机暂存根复制成独立的 `config/global-update.r2.json`，仅将 `contentPublication.root` 改为 `/srv/ournotes-updater/app/output/r2-global-content`，并确认没有整站 `publication`；不要修改旧配置。仓库 Variable `R2_GLOBAL_CONFIG_PATH` 设为 `config/global-update.r2.json`。该私有文件只进入私有状态桶，不提交到 Git。补充 profile 时，先以当前指针 SHA-256 为 CAS 基线生成十一路径检查点，再成对更新 `R2_GLOBAL_STATE_PATHS` 与 `R2_GLOBAL_DECODER_PROFILE_PATH`；切换期间保持生产开关关闭。`R2_GLOBAL_DECODER_PROFILE_PATH` 是必需的根相对路径，设为 `config/bundle-decoder-profiles.json`，并将经可信客户端元数据身份核对的 profile 放在暂存根下的该路径，明确列入私有检查点。配置缺失或路径不在选择列表中时，工作流会在大规模恢复前失败；不能用 `clients/*/decoder.json` 缓存收据代替外置 profile。Global 的 APK 签名工具、decoder profile、baseline、input plan、initial observation/package 与私有工作目录均要在恢复后存在；公开内容库由本次任务在独立目录重新封存并上传，不列入私有检查点。旧服务器现有续跑状态引用 `output/costume-release-inputs-20261003/release-inputs.json`；原五路径清单遗漏该目录。下方新清单含整个动态 `sync-complete`，使下一版本产生的新目录继续被纳入检查点，且保留旧 formal 输入作为初始回退。`builds` 与 `conversions` 可在恢复后重新生成；旧服务器仅清理了上方明确授权的三个历史目录，当前和保留 builds 仍须保留。`R2_GLOBAL_STATE_PATHS` 必须与首次检查点的 `--path` 完全一致；状态引用变动时先重新审计并更新清单。
6. JP 首期检查点固定为 `output/r2-jp`，需包含二进制 `metadata.v39.dat`、`unity-version.txt`、`apks/`，以及后续 `workspace/`。公开内容的本地封存目录为独立的 `output/r2-jp-content`，不进入私有检查点。本机 `~/Documents/data/otonote/resources/input/jp/` 中的 1.0.4 三个 split APK、元数据及 Unity 身份已通过 `tools.prepare_jp_r2_seed` 验证；工具固定了签名证书 SHA-256 `34fd32c2860f454dd320930f6ba0876ea8cc8e60a3d8320b3277aa761072508e` 与整套 APK 的摘要 `b50122ad3e56a8afc64f6fb77e06cbf29240adcf83783ba602af74a32369b28c`。在本机暂存根生成种子即可，避免复制约 4.6 GB 的整份手机缓存。新客户端版本或未知解码映射必须阻断。不能把未知网上 APK 自动设为可信输入。固定 1.0.4 元数据最初在原出口探测时返回 HTTP 403，随后经授权的日本单节点在托管 runner 上通过版本探测；完整生产验收见本文开头的运行记录。任何新拒绝或解码失败仍须保持公开指针不变。

### 私有状态首次导入

首次上传大体量私有状态前，已运行 [Probe R2 credentials read only](https://github.com/stonesver/otonote/actions/runs/37230824175)。它只对两个指定 bucket 做最多一条对象的列表请求，不读取对象内容、不写入或删除对象；结果证明密钥与 bucket 的读取/列举权限可用，不证明生产状态或内容已经存在。该工作流现在还会拉取已固定摘要的生产镜像并报告剩余磁盘；传入 `expected_restore_bytes` 可检查恢复字节数加 8 GiB 预留是否足够。它与生产工作流使用相同的 `CONTENT_R2_RUNNER_LABEL`。

可以在本机建立临时 `$STAGED_ROOT`，从旧服务器只复制下方十一条所选路径，并保留硬链接（例如使用 `rsync -aH`）；无需把 JP 种子或 Python 依赖写入旧服务器。检查点的 `--root` 指向本机副本，`--recorded-root /srv/ournotes-updater/app` 则把 Actions 将使用的绝对路径写入清单。旧 `state.json` 中的绝对路径不要改写；清单恢复时会核对记录的根和精确的路径选择。复制须在旧服生产任务静止期间完成，并在上传前核对源文件未变化。2026-10-05 实测最初十路径收紧清单有约 **48.1 GB 逻辑文件字节**、约 **9.4 GB 独立 inode 字节**、约 18 万个文件；本机若未保留硬链接，实际占用可能接近逻辑字节数。硬链接保留版恢复按独立 inode 估算容量，另预留 8 GiB、仓库、镜像与新产出。旧服务器直接流式上传已有文件也无需再腾出整份数据空间；容量门槛发生在 Actions runner 恢复时。首次检查点前需使用支持约 66 MB 清单与硬链接恢复的新版 `tools.r2_state`。标准 runner 是否够用必须以真实清单和 `df` 检查为准，容量不足时改用更大 GitHub 托管 runner。影子运行前不要删除旧服原文件。`--path` 必须与之后工作流使用的路径列表一模一样。

收紧依据、硬链接语义和失败回退见 [R2 状态设计](R2_STATE_DESIGN.md)。清单只减少传往 R2 的路径，不会清理旧服务器磁盘。

批量传输可对 `checkpoint` 和 `restore` 指定 `--workers 8`；默认串行，允许范围为 1–16。Actions 固定使用 8 个传输线程。并发只用于不同内容对象的上传与回读或下载；所有校验完成后才提交检查点指针或物化恢复目标，硬链接关系保持不变。该参数不减少摘要校验，也不扩大路径清单。

JP 可在本机运行 `python3 -m tools.prepare_jp_r2_seed --metadata <本机global-metadata.v39.dat> --apk-root <本机三份split-APK目录> --unity-version-file <本机unity.ver> --output "$STAGED_ROOT/output/r2-jp"`。目标目录必须预先不存在；工具会校验 1.0.4 版本、签名证书指纹、整套 APK 摘要和元数据摘要，并产生 `seed-manifest.json`。这些源文件留在本机，私有桶只存检查点，不向公开桶复制。随后运行下方 JP `checkpoint`。首次导入时旧服务器约有 207 MB 可用空间，因此未在该盘直接新建 JP 种子；其系统 `python3` 也只有 3.6。下面命令应在本机 Python 3.11+ 环境执行，安装 `tools/r2-requirements.txt` 到本机虚拟环境。R2 凭据只放本机受控环境或 GitHub Secrets，不写入仓库、命令参数或聊天。

Global 在本机暂存根中准备独立配置；旧服务器的 `global-update.server.json` 不变：

```bash
# 在已激活 Python 3.11+ 虚拟环境的仓库根运行；先设置本机暂存目录。
export STAGED_ROOT="$HOME/Documents/data/otonote/private/r2-migration/stage"
python3 - <<'PY'
import json, os
from pathlib import Path
p = Path(os.environ['STAGED_ROOT']) / 'config/global-update.r2.json'
assert not p.exists(), 'R2 config already exists; review instead of overwriting'
config = json.loads(p.with_name('global-update.server.json').read_text())
assert isinstance(config.get('contentPublication'), dict) and not config.get('publication')
config['contentPublication']['root'] = '/srv/ournotes-updater/app/output/r2-global-content'
p.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
PY
```

```bash
# 仍从仓库根运行；暂存目录只存私有输入，不需要包含程序代码。
python3 -m pip install -r tools/r2-requirements.txt
# 先在环境中设置 R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY、R2_PRIVATE_BUCKET。
python3 -m tools.r2_state current --root "$STAGED_ROOT" --region global
python3 -m tools.r2_state checkpoint --root "$STAGED_ROOT" --recorded-root /srv/ournotes-updater/app --region global \
  --expected-current none \
  --path config/global-update.r2.json \
  --path config/bundle-decoder-profiles.json \
  --path output/global-update-workflow/state.json \
  --path output/global-update-workflow/last-package.json \
  --path output/global-update-workflow/sync-complete \
  --path output/global-update-workflow/cache \
  --path output/global-update-workflow/clients \
  --path output/costume-release-inputs-20261003 \
  --path output/formal-inputs/global-current-complete-104-v4 \
  --path output/verification/global-remote-20260927 \
  --path runtime/apksig-9.4.1.jar
python3 -m tools.r2_state checkpoint --root "$STAGED_ROOT" --recorded-root /srv/ournotes-updater/app --region jp \
  --expected-current none --path output/r2-jp
```

Global 仓库 Variable `R2_GLOBAL_STATE_PATHS` 对应上方十一条路径的 JSON 数组。若 `current` 已有指针，必须先审查旧清单，使用返回的 `currentSha256` 作为 `--expected-current`，不要覆盖现有状态。首次导入后应在隔离环境的相同绝对根做恢复演练；恢复要求目标文件不存在，不能覆盖本地文件。可用 `python3 -m tools.r2_state inspect --root /srv/ournotes-updater/app --region global` 加上相同的十一个 `--path`，只读取得逻辑与实际恢复字节数。

## 工作流门禁与日常运行

镜像发布先于任何内容生产。在 Actions 手动运行 **Publish reviewed updater image**；审查日志中的源归档摘要、公开 Node 基础镜像、工具检查与 GHCR digest，并将 summary 给出的完整 `ghcr.io/...@sha256:...` 写入 `OURNOTES_UPDATE_IMAGE`。发布工作流只允许默认分支执行，使用该仓库的 `GITHUB_TOKEN`，不需要在聊天里传递镜像仓库密码。内容工作流使用 `packages: read` 的 `GITHUB_TOKEN` 登录同一 GHCR 包，按固定摘要拉取。

`.github/workflows/content-r2.yml` 两服各每四小时运行一次，UTC 错峰；GitHub `schedule` 可能延迟或丢弃，须人工核查最后成功时间。相同区服 `concurrency` 串行且不取消正在运行的生产；两服独立。工作流仅在受保护默认分支启动。

启用前在仓库 Variables 设置：

| 名称 | 值 |
| --- | --- |
| `OURNOTES_UPDATE_IMAGE` | 已验证存在的生产镜像，必须固定 `@sha256:` 摘要 |
| `CONTENT_R2_RUNNER_LABEL` | 可选；缺省 `ubuntu-latest`，容量检查失败时填实际开通的 GitHub 托管大容量 runner 标签 |
| `R2_GLOBAL_CONFIG_PATH` | 私有配置的根相对路径 |
| `R2_GLOBAL_STATE_PATHS` | 精确恢复路径的 JSON 数组 |
| `R2_GLOBAL_DECODER_PROFILE_PATH` | 必需，可信 Global decoder profile 的根相对路径，且须包含在状态选择列表中 |
| `CONTENT_R2_ENABLED_GLOBAL` / `CONTENT_R2_ENABLED_JP` | 分服设为 `true` 才允许运行；缺省关闭 |
| `CONTENT_R2_AUTO_PROMOTE_GLOBAL` / `CONTENT_R2_AUTO_PROMOTE_JP` | 经影子验收后设为 `true`，此前定时任务只上传不可变内容，不切公开指针 |

工作流手动 `Run workflow` 可选 `global` 或 `jp`，以及 `shadow` 或 `promote`。**先使用 shadow**：从私有状态恢复，执行生产，上传并读回公开不可变对象，写回私有检查点；R2 `content/current.json` 或 `content/jp/current.json` 不变。Actions run 本身是最后尝试记录；私有 `state/<region>/current.json` 是最后可恢复的生产检查点；公开 `content/promotions/<region>/...` 与对应 `current.json` 记录已晋级内容。失败时停在当前步骤，公开指针不变。私有检查点在公开晋级前提交，因此晋级失败时它可能比公开指针新；重跑会按公开指针基线再次校验并尝试晋级。

全新 runner 不恢复独立的本地公开内容库，不能仅凭 producer 的本地 `unchanged` 分支避免重复生产。`tools.r2_production_gate` 在完整恢复后，通过生产镜像重新探测官方版本；Global 同时使用与生产相同的可信客户端校验，必要时更新本地包缓存，再按实际客户端版本探测。门禁比较完整生产源码和工具链、工作流、固定镜像摘要、私有运行配置或可信 JP 客户端输入，并检查上次成功计划及其生产预检。只有成功回执对应的公开指针仍在线、清单摘要和区服绑定正确、末尾指针复查一致时，才跳过生产、公开上传、私有检查点和晋级。

[无变化门禁及两服 JSON 输出修复](https://github.com/stonesver/otonote/pull/31) 已在提交 `fec5aa081e54c1a031cdd1e0b66a92b7d4dbddf7` 合并，两套远端 CI 通过；真实 runner 的首次回执建立及后续跳过验收仍待完成。

成功回执只在真实生产和公开对象完整上传读回之后，写入已纳入私有选择范围的生产 `state.json`，随后随检查点保存。旧检查点没有回执、上游或代码变化、公开指针未晋级等情况继续完整生产；探测失败或已匹配的清单损坏阻断。PR31 的初版优化仍需要每轮完整恢复私有输入，不能宣称零 R2 请求，也不是首次影子验收的替代品。

Global 的 `compile-data` 失败后，工作流会尝试将该次 `latest-run.json` 指向的编译日志保存在私有桶 `diagnostics/global/<run-id>/<attempt>/compile-data.log`。只保留最后 4 MiB，回执记录原长度、是否截断、SHA-256 和完整读回校验结果；Actions summary 不显示日志内容。目录或日志为符号链接、路径不属于本次工作区、读取时文件变化均拒绝保存。此步骤失败也不改变原生产失败结论，不写成功检查点或公开指针。诊断文件可能含私有路径或上游敏感消息，不能复制到公开 artifact、聊天或公开内容桶。

只检查本地封存包而不连接 R2 时，可运行 `python3 -m tools.r2_content upload --region global --store <内容库> --dry-run`；公开对象已影子上传后，可用 `promote --dry-run` 搭配 `--expected-current` 和 `--source-run` 复核远端完整性及指针基线，不执行切换。

影子 run 至少检查：真实 runner 空间峰值、完整耗时、官方版本身份、客户端签名和解码校验、Global/JP 候选与封存回执、R2 读回摘要、两服交叉引用和现有网页预渲染。`ubuntu-latest` 的资源规格会因仓库类型变化，不要只按名义磁盘值判断；实际以 `df` 和 run 记录为准。[GitHub 托管 runner 规格](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

## JP 版本接口的指定代理出口

可在 `content-r2-production` Environment Secrets 中配置可选的 `OURNOTES_JP_VERSION_PROXY`，支持 `http://`、`https://`、`socks5://`、`socks5h://`。它只传给 JP 生产容器，仅用于固定允许的 Version RPC；CDN 下载不读取该变量。代理认证通过 curl 标准输入传入，错误和观察回执不包含代理凭据。TLS 验证保持开启；403 仍立即阻断，不能把旧快照当作最新版本。

本机 Clash 的 `127.0.0.1` 端口只适用于本机验证，不能直接填给 GitHub 托管 runner。订阅也不是 HTTP/SOCKS 代理地址。当前已使用经授权的 `OURNOTES_JP_PROXY_NODE` 单节点 Secret，在临时 runner 启动固定摘要客户端；配置仅允许固定 Version 主机名，结束后清理进程和配置。不要同时设置 URL 与单节点两种模式。详见[出口配置与真实探测结果](JP_VERSION_EGRESS.md)。实际出口应通过连接记录确认，不能只凭订阅相同或节点名称判断。完整影子生产通过前保持 JP 定时生产和自动晋级关闭。

本机初始 R2 上传还受 Clash TUN 路由影响：即使 S3 客户端配置 `proxies={}`，也只绕过 HTTP 环境代理，并不保证物理直连。2026-10-05 控制器观察到 HTTP 代理和 TUN 两类 R2 连接均走节点链，DIRECT 为零。该阶段流量会消耗代理套餐；不能把 R2 免费出网等同于代理供应商免费流量。

Global 上传结束后暂停了旧快照上传，在本机运行配置最前面临时添加仅匹配该账户 R2 endpoint 的 `DOMAIN,...,DIRECT` 规则；原始 Clash 配置文件未修改，节点选择保持一致。一次新的私有指针 HEAD 返回 200，控制器确认新连接为 `Domain` / `DIRECT` 后才恢复上传。此规则只在本机当前运行配置中，Clash 重载或重新选择配置后须重新核对；初始导入结束后应恢复原配置。GitHub 的 JP 单节点代理只允许 Version 主机名，不承载 R2 或 CDN 传输。

本机初始导入完成后已恢复原 Clash 运行配置，保留当时各 Selector 的选择，并删除本任务生成的临时配置副本；原订阅文件始终未修改。

JP 生产指纹按生产源码、配置和镜像构建依赖的内容摘要计算，不使用整个仓库提交号；仅修改文档不会让下一轮重新采集。指纹算法升级后首次运行会建立新的基线。无可用门禁回执或未匹配线上内容时，新 runner 仍从私有缓存重建本地公开内容目录并完整校验 R2 对象；通过上方无变化门禁时可跳过这些步骤，但私有恢复仍产生 R2 读取。

## R2 请求与存储成本

截至 2026-10-05，[Cloudflare 标准存储价格](https://developers.cloudflare.com/r2/pricing/)每月包括 10 GB-month、100 万次 Class A 和 1,000 万次 Class B 免费额度。超额存储为 $0.015/GB-month；A 为 $4.50/百万次，B 为 $0.36/百万次，按计费单位向上取整。出网免费不包括 Workers 或 GitHub Actions 费用；不频繁访问存储不适用这些免费额度。

首次导入按对象上传并完整 GET 校验，所以对象多时操作计数会快速上升。日常重复上传先完整读取已有不可变对象，匹配则复用，省去重复的条件 PUT；全新对象仍条件写入并读回，已有对象损坏时失败且不覆盖。并发只影响速度，不会减少对象总请求数。启用定时任务前记录一次真实运行的新增/复用对象数、读取次数、运行时长和存储增量，再按计划频率估算月用量。旧版本仍按独立引用审计保留，不能用任意过期规则删除当前或仍被网页引用的内容。

2026-10-05 对已验证 Global 私有清单 `4aaba388…` 的只读统计：180,059 个路径对应 18,878 个唯一对象、7,846,295,344 字节；单轮完整恢复按唯一对象 GET。只按每四小时一次、30 天估算，这部分约 340 万次读取，另加控制对象、实际变更时的上传校验、JP 和访客读取。私有桶还包含一次性的旧公开快照中转及历史对象，桶总量不等同于当前 Global 工作集。JP 尚须在首次完整检查点后实测，不能用最初六文件种子估算长期成本。

## 现有域名的只读 Worker Route

### 保留现有网页引用的旧快照

旧 Global/JP 网页（包括当时保留的 previous HTML）分别引用 `ac630c24b69b23fd89da8821`、`98d922dbc6fca1d5d8d991d8`。启用覆盖整个 `/content/*` 的 Route 前，必须让这些固定地址在 R2 可读，不能只上传新的 current 快照。

`tools.r2_legacy_bootstrap` 用私有桶固定命名空间 `migration/legacy-public/` 中转这两份原样封存快照，与正常 Global/JP 生产状态完全分开。本机先组装独立 ROOT/content，仅含两份指定 release（含私有封存回执）及 `current.json`、`jp/current.json`，再执行 `python3 -m tools.r2_legacy_bootstrap seed --root <本机旧快照暂存根> --workers 16`。工具校验两服固定身份、封存清单和全部文件；首次检查点默认要求空基线。它不会把旧 JP 快照视为自动追新成功。

随后从 main 手动运行 **Bootstrap sealed legacy content in R2**，先选 `shadow`。工作流检查 runner 实际恢复容量，从私有命名空间恢复并重验两服，在 Actions 内使用已有双桶凭据完成公开对象上传和完整回读；`.receipt.json` 不进入公开桶。显式 `promote` 才会校验两服后依次 CAS 更新指针，并拒绝用这两份旧指针覆盖未知新版本。两服 CAS 不是一个事务，任一失败须先检查运行证据；Route 仍保持未切换直到两服均通过验收。更早打开的历史标签页引用另需按保留策略核查。

仓库提供 `deploy/r2_content_gateway.mjs` 和 `deploy/r2-content-gateway.wrangler.example.json`。在控制台选择 **Start with Hello World**，名称 `ournotes-content-gateway`，创建后将 `worker.js` 全部替换为网关代码。Worker 的 R2 变量名必须为 `CONTENT`，绑定 **`otonote-public-content`**；绝不绑定私有状态桶。先在其 `workers.dev` 测试地址验证允许的 GET/HEAD 和拒绝的私有路径；在真实快照可读且浏览器验收之前，不添加线上 Route。空桶时 `/content/current.json` 返回 404 是预期结果。

现有服务器预渲染前，使用单独的 **仅可读取公开桶对象** 的 R2 API 凭据运行 `python3 -m tools.materialize_r2_content --store /srv/ournotes-r2-prerender-content --region all`。该命令只物化两服清单、清单引用的数据文件、画廊清单和两张加载图；普通媒体继续留在 R2。物化目录必须独立于旧 Nginx 完整内容库，避免提前切换源站指针而缺少媒体。服务器凭据不要复用 Actions 的写入密钥。

2026-10-05 两次获批清理分别移除了三个无引用的旧更新器派生目录，以及 22 个更早版本的 HTML 子目录；第二次在旧发布器 `.render.lock` 内复核四个当前/上一版链接后执行，保留所有历史 payload、完整标记和原始素材，实际释放 3,440,513,024 字节。两服 HTTP 200、旧预渲染触发器 active；当时服务器可用约 5.21 GB。此记录不授权以后自动删除历史内容，也不表示 R2 预渲染服务或 Worker Route 已启用。

[预渲染服务部署示例](../deploy/r2-prerender.README.md)提供独立物化、双服暂存 HTML 验收和指针推广。**Publish R2 prerender image** 工作流从 main 构建固定摘要镜像并提供带 SHA-256 的短期离线归档，可从本机流式导入旧服务器，服务器无需保存镜像压缩包或持有 GHCR 凭据。示例未自动启用；启用前须测算并满足旧服务器实际增量空间，停用旧预渲染 path、timer 并等待 service 退出，防止竞争，验证两服 staged HTML，再启用新 timer。回退须先使用旧完整内容库恢复可用旧 HTML、确认媒体可读，再撤 Worker Route，最后恢复旧 timer。

切换时，在 Cloudflare 控制台进入 **Workers & Pages → 选择该 Worker → Settings → Domains & Routes → Add → Route**，选择 `stonebg.cn` zone，填写 `ournotes.stonebg.cn/content/*`，保存。`ournotes.stonebg.cn` 现有橙云 DNS 记录已满足 Route 前提。该 Route 仅接管 `/content/*`；网页与其他路径继续走现有源站。Cloudflare [Route 官方步骤](https://developers.cloudflare.com/workers/configuration/routing/routes/)和 [R2 Worker binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)可对照操作。

Route 切换后检查：`/content/current.json`、`/content/jp/current.json` 返回新旧预期摘要且 `Cache-Control: no-store`；两服 manifest、JSON、图片、音频、Live2D 均可读；隐藏文件、APK、列目录和写入请求被拒绝；四个语言入口、跨服引用、预渲染与动态服务正常。旧 Nginx 内容库和位置配置在切换期保留。

## 故障和回退

- 生产失败或 R2 校验失败：保持 `CONTENT_R2_AUTO_PROMOTE_*` 关闭或设回 `false`；检查 Actions 失败步骤、私有检查点、公开晋级记录。不要删除旧 release。
- Worker Route 故障：先用旧完整内容库恢复并验证旧 HTML，确认两服 HTML 引用的媒体在源站可读，再在 **Domains & Routes** 删除 `ournotes.stonebg.cn/content/*` Route，最后恢复旧预渲染 timer；避免新 HTML 在撤 Route 后引用源站不存在的快照。
- 公开内容需要回退：先运行 `python3 -m tools.r2_content baseline --region global`（JP 改为 `jp`）取得 `currentSha256`，检查返回的 `previousPointer` 是否指向所需旧版本，再运行 `python3 -m tools.r2_content rollback --region global --expected-current <currentSha256> --source-run <工单标识>`。命令验证旧清单及所引用的 JSON 后写晋级记录，并用条件写切回旧指针；普通媒体的完整性仍须在 Worker 测试地址抽验。不要在控制台直接手改 `current.json`。紧急情况下优先撤 Route 回到原站内容。
- 新流水线通过真实定时运行、Route 和浏览器验收后，才停止服务器旧的 `global-update.timer`。保留旧源站内容和旧 HTML 引用；历史对象清理仍由独立引用审计决定，不由工作流自动删除。

## 日常性能改造（2026-10-05，待真实 runner 验收）

设计和执行顺序见 [性能设计](designs/2026-10-05-r2-update-performance-design.md) 与 [实施计划](plans/2026-10-05-r2-update-performance-plan.md)。本节描述本次实现；不代表正在运行的旧工作流已经使用这些优化。

- **轻量版本检查**：私有 receipt schema 2 绑定已验证 APK/metadata/config 库存；在恢复历史状态前只取控制清单和少量探测输入。公开版本已晋级且版本/输入/代码/镜像都一致才跳过。旧 receipt、首次 JP 种子、上游变更走原完整路径。尚无真实 runner 无变化计时。
- **共享媒体**：`tools.r2_content upload --shared-media` 把全部 `public/`（包括模型与动作 JSON）保存为 `content/blobs/<sha256>`，逻辑 URL 保持不变。首次完整 SHA 读回，后续以已验证目录加当前 LIST 中 key/size/ETag 复用；ETag 本身不是首次内容校验。promote 对共享媒体同样核对目录及存在性，locale JSON 仍完整校验。控制索引不通过 Worker 公开，旧 release 不转换、不删除。
- **兼容部署前保持 `CONTENT_R2_SHARED_MEDIA=false`（默认）**：先更新 `deploy/r2_content_gateway.mjs` 的 Worker、构建并安装含新 materializer 的固定摘要预渲染镜像，完成测试地址验收后才启用共享上传。仅部署 Worker 不表示要立即添加线上 Route。
- **预渲染下载**：manifest 已绑定必须文件的 SHA 与长度，省略这些文件的重复 HEAD；只有可选美术做 HEAD。最多 8 个并行下载，每个仍校验完整正文，全部成功后才换指针。该改造减少下载等待，不改变 HTML 生成成本。

本地已封存旧快照统计：Global 22,814 个文件中 20,418 个 public 逻辑文件可共享（14,802 个唯一内容），剩 2,396 个直接存储文件；JP 分别为 22,689 / 20,331 / 14,633 / 2,358。真实下一版有多少内容变化尚未知，因此不能按此直接承诺整个更新耗时。

操作量回归测试以 257 个不变媒体为例：第二个 release 媒体正文 GET=0、PUT=0，仅一次 blob LIST 与有限映射控制读取；新增一个媒体只 PUT 该新 blob。新 blob 损坏、旧 blob 丢失/ETag 改变、分片损坏都会阻断或重新完整验证。以上是本地受控测试结果，不是线上耗时。

### 性能改造实施记录

[PR32](https://github.com/stonesver/otonote/pull/32) 已合并为 `405130991d60f27364e1b791cd15104822d87b33`。两套 verify 分别用时 1m21s / 1m26s，均通过；本地 102 项相关 Python、9 项网关测试通过。这些不是生产更新端到端耗时。

旧快照 shadow [37259448587](https://github.com/stonesver/otonote/actions/runs/37259448587) 于 06:13:20 UTC 成功完成；Global 22,814、JP 22,689 个对象均上传和完整读回，公开晋级步骤跳过。上传读回步骤共 148m05s，属于旧实现的首次迁移。

兼容预渲染镜像 [37271579713](https://github.com/stonesver/otonote/actions/runs/37271579713) 构建成功；本机验证了归档 SHA256 `d9dfce31f65de0d2e5101cd14cf5f8bee7a8648d83010df8bb1d18ed168d8b0c`、26 个 OCI blob、linux/amd64 平台与源码标签。不可变 image ID `sha256:fc6fbbfcf43ee8bc7bedf1b80d296b4cee48d54d699e2b41d976b6877bb0a594`，归档 136,230,557 字节。此前 SSH 在认证前断开；连接恢复后已流式载入服务器，核对 image ID、源码标签、平台并通过禁网只读容器导入检查。新服务配置已固定此 image ID，保留旧 env 备份；服务与 timer 仍 inactive/disabled。

已请用户更新兼容 Worker；尚未收到完成确认。共享开关、线上 Route、新预渲染服务均未在本轮启用，真实无变化/增量运行和迁移切换仍待验收。

### 直接布局验证记录与小快照验收

`tools.r2_verified_release` 在直接布局上传的完整 SHA256/长度读回之后，记录同一次 GET 返回的 ETag。内部 `content/verification/<releaseId>/` 目录有最多 16 个摘要分片，最后写入 completion；它绑定 manifest SHA、完整文件库存及长度。重复上传、晋级预检和晋级时重新 LIST 该 release，严格比较 key、大小和 ETag；损坏、缺失、多余对象或损坏目录均阻断。没有 completion 的旧快照仍完整读回，不能用旧 shadow 的汇总回执冒充逐对象证据。

手动工作流 **Check R2 shared delivery** 上传一个很小的不可变测试快照，验证 Worker 测试地址上的相对 Live2D JSON/贴图路径、MIME、GET/HEAD/Range 和内部路径拒绝。它不写两服公开 current/previous 指针、不添加 Route，也不启用共享生产开关。失败证据仍保存为短期 Actions artifact。

本轮本地验证：39 项发布/验证目录/小快照 Python 测试、9 项网关测试通过；独立静态审查未发现阻断项。实际 Worker 验收及迁移晋级尚未执行。

### 真实小快照探测发现（2026-10-05）

PR33 已合并为 `4674e222c8f925a8c58feeb31910ab20d012b0fd`，两套 verify 均通过。Global shadow `37262193107` 和 JP shadow `37262141589` 都已完成生产、公开上传及私有检查点，公开晋级均跳过。旧快照 bootstrap `37281443762` 已以 promote 模式启动；未切网站 Route。

小快照探测 `37281403485` 完成上传，但默认 `Python-urllib` 客户端被测试域名返回 403/1010；本机只读对照中，明确的项目客户端标识 `otonote-delivery-probe/1.0` 可访问相同资源。探测脚本据此设置明确 User-Agent。

相同资源的普通 GET 实际返回 206 和完整 `Content-Range`。R2 对象可能携带完整范围信息，Worker 不能仅凭 `object.range` 决定 HTTP 206；现改为只有客户端请求 Range 且 R2 返回 range 时才返回部分响应，并补普通 GET/HEAD/可变 pointer 回归。共享模型 JSON 当前仍为 404，已请用户部署兼容 Worker；10 项网关、3 项探测测试通过，真实共享交付尚未通过。

### Worker 验收与预渲染切换进行中

用户已部署兼容 Worker。托管 runner 的共享小快照验收 [37287119280](https://github.com/stonesver/otonote/actions/runs/37287119280) 成功；本机另对两服共 16 项真实资源样本核对 SHA、HEAD、音频 Range、缓存头与内部路径拒绝，均通过。

旧快照晋级 [37281443762](https://github.com/stonesver/otonote/actions/runs/37281443762) 成功，两服 current 均从 none 建立。Global/JP 分别复用 22,814 / 22,689 个已上传文件，完整读回约 705 / 711 秒；随后的预检约 37 / 33 秒，晋级约 33 / 33 秒。任务总计 39m56s，包含恢复 13m52s。旧 shadow 的 148m05s 包含首次上传，缓存条件不同，不能宣称同等工作提速六倍。

服务器已保存 `/etc/ournotes/r2-cutover-before.json`，停用旧预渲染 path/timer并确认旧 service 已退出，然后手动启动新 R2 service；首次物化仍在进行。两服旧 HTML、previous、完整旧内容库保留，新 timer 尚未启用，旧 Global 生产 timer 仍启用，网站 Route 尚待用户添加。

共享开关启用后，上传工作流先选择已有不可变布局：相同 manifest 的既有 direct release 继续使用 direct，新 release 使用 shared；已有 shared descriptor 交给共享上传器继续严格验证，manifest 不一致直接阻断。避免开启共享开关时尝试原地改变旧 release 布局。

### 费用基线（2026-10-05，非固定账单）

用户截图显示 R2 Standard 总容量 36.77 GB、Class A 138.64k、Class B 475.37k。若容量整月不变、账户仍有标准免费额度，按 10 GB-month 免费和 $0.015/GB-month 计，存储约 $0.41/月（计费单位进位）；目前操作数量低于月免费 A 100 万/B 1000 万。实际存储按每日峰值平均，不以某次截图直接结算。出口流量免费。见 [R2 定价](https://developers.cloudflare.com/r2/pricing/)。

Workers 免费档有每日 10 万请求和每次 10ms CPU 限额；付费档最低 $5/月，含月 1000 万请求、3000 万 CPU ms，超额另算。资源请求数不是访客数。当前 Worker 只设置浏览器缓存和进程内映射缓存，不能把它解释为所有 R2 正文已进入边缘缓存。见 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)。

已核对仓库公开，当前标准 ubuntu-latest runner 运行时间免费；GHCR 容器存储/带宽当前免费。Actions 活跃 artifact 144 个、合计约 2.44 GB，其中预渲染镜像归档约 545 MB；这不是账户账单，产物额度/实际计费仍应以 GitHub billing 为准。旧服务器、域名、日本代理订阅价格未提供，不包含在以上新增 Cloudflare 估算中。见 [Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions) 与 [Packages](https://docs.github.com/en/billing/concepts/product-billing/github-packages)。

### 服务器 R2 渲染接管验收

首次 R2 service 成功退出：Global 2,398 文件 / 194,913,938 字节，JP 2,358 文件 / 182,264,510 字节；现有两服 HTML 与 R2 pointer 一致，输出 `unchanged`，没有重新构建整站。第二次手动服务运行成功，实测 **19.401 秒**，四个 current/previous HTML 链接均与切换前相同。回执 `/etc/ournotes/r2-prerender-repeat-acceptance.json`；这是服务器复用检查耗时，不是生产管线端到端耗时。

新 `ournotes-r2-prerender.timer` 已 enable/start；旧 `ournotes-prerender.path` 和 `.timer` 保持 disabled/inactive。浏览器 Global 首页 88 张图片和 JP 音乐页 547 张图片均无已完成加载的破图。尚未收到网站 `/content/*` Route 添加完成确认；旧 Global 生产 timer 仍保留。

PR35 合并为 `c7011af9d3021cf253bfe6798903eb1a093db8c3`，两套 CI 通过。兼容 Worker 和 R2 reader 验收后，仓库 `CONTENT_R2_SHARED_MEDIA=true`，开始新流程影子运行以建立 schema 2 的轻量门禁回执；生产调度/自动晋级开关仍按单次验收模式保持关闭。

### 线上 Route 已接通

用户确认添加 `ournotes.stonebg.cn/content/*` Route 后，线上域名的小快照 12 项验收通过；该快照只存在 R2，证明请求实际经过新 Worker。两服真实资源 16 项 SHA/HEAD/Range/访问边界抽样通过。刷新 Global 首页和 JP 音乐页后，88 / 547 张图片均无已完成加载破图；新 R2 渲染 timer 持续成功。

为避免新影子任务结束后再次完整恢复/生产，只在核对仍处于 `Restore last verified private state` 阶段后，取消影子 Global `37288596444`、JP `37288663753`，改用同一已合并版本的手动 promote 验收。取消发生在公开上传、私有检查点、公开晋级之前；常规调度与自动晋级开关仍关闭。
