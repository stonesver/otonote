# G 与截图导入上线验收（2026-10-14）

状态：镜像、双服索引、前端已上线；公开内容、页面交付和正式截图流程验收通过。用户明确授权先更新生产镜像，再发布双服索引与前端，继续完成线上验收；不重复既有验收，不推进暂缓项。实现及本地行为证据见 [功能状态与截图导入](2026-10-13-feature-status-and-screenshot-import.md)。

## 镜像与源码

- [PR #97](https://github.com/stonesver/otonote/pull/97) 两项 CI 通过后合并为 `2ab0745ea06f6aa5758b9ef008486ed480c29c6f`。
- 唯一镜像运行 [38497009436](https://github.com/stonesver/otonote/actions/runs/38497009436) 成功：Linux 构建、离线依赖导入、推送和 digest 回读全部通过。
- 新生产镜像：`ghcr.io/stonesver/otonote-update@sha256:5647a1abda0b9fd6c51dab1fde8ccf9377d2a3c2b0a38e22307bccc63c1d11ce`。仓库变量已切换并逐字回读。
- 回退镜像：`ghcr.io/stonesver/otonote-update@sha256:49575705cb0c4b0db0346f8a79d2bba1754667e48307e6322525caf93a488fe0`。
- [PR #98](https://github.com/stonesver/otonote/pull/98) 两项 CI 通过后合并为 `2cabfc2f678a60feabc7e08320c34ac04f10feac`。另将新增功能状态测试接入既有 CI，没有改变服务器发布器的验证协议。
- 主分支 [CI 38497479846](https://github.com/stonesver/otonote/actions/runs/38497479846) 成功。直接复用其正式候选，未重复构建：代码 `c102d0f93b5098868d4ba573`，验证回执 SHA-256 `941814b1ec5292e5f6ca89d3a59dc0b25c921ef87b378fa86f641c1bc685761a`。
- 下载后完整性及源码提交绑定检查通过，部署 dry-run prepared。服务器现有 `code_publication.py` 与 `release_candidate.py` 和本地逐字一致，无需升级发布器。

## 调度与生产

镜像依赖提交会改变生产指纹。为避免中间版本触发额外生产，镜像发布窗口内暂将双服 `CONTENT_R2_ENABLED_*` 设为 false；合并功能及配置新镜像后均恢复 true 并回读。快速探测开关保持 true，未取消任何任务或停止现有网站服务。

确认没有本批运行后，各派发一次所需的正式 promote：

| 区服 | 运行 | 派发时间（UTC） | 当前验收 |
| --- | --- | --- | --- |
| Global | [38497526196](https://github.com/stonesver/otonote/actions/runs/38497526196) | 01:46:38 | 成功，36 min 24 s；公开双语门禁与索引回读通过 |
| JP | [38497529250](https://github.com/stonesver/otonote/actions/runs/38497529250) | 01:46:40 | 成功，76 min 18 s；公开双语门禁与索引回读通过 |

未重复派发旧空 runner 或无变化验收，没有运行 `finish_cloud_acceptance.py`。后续自然定时任务按既有同服串行和生产门禁处理。

## 公开内容验证

Global 快照 `856eb982b9af67f4f261e1bc`：客户端 1.0.3（56），资源 `1.0.1.500.a3f7b2e9`，索引 136/136。JP 快照 `197f3fae5d336bdcf1fdf40f`：客户端 1.0.5（10059），资源 `1.0.0.400/1734a4a0832e8fee9ed3f00c7f5450e7`，索引 135/135。双服索引缺失均为 0，成员新卡 65、66、67 均已覆盖。

对真实公开 current、manifest、双语目录、评分及索引文件逐项核对原始字节和摘要，`--require-recognition` 门禁通过。评分仍为 `reference_compatible`、`gameplayVerified: false`，没有把索引可用当作实战认证。

| 阶段 | Global | JP |
| --- | ---: | ---: |
| 镜像拉取 | 33 s | 72 s |
| 状态恢复 | 838 s | 994 s |
| 内容生产 | 208 s | 1,765 s |
| 上传与回读 | 578 s | 607 s |
| checkpoint | 363 s | 970 s |
| 晋级 | 125 s | 138 s |

GitHub 状态查询曾遇到瞬时 EOF；实际双服任务均成功，未因此重派。原 watcher 的 JP 后续公开检查未执行，确认运行成功后单独执行一次，结果通过。

前端正式发布回执 `code_published`，codeId 与上述 CI 候选一致。双服网页主指针、交叉引用与现用代码全部一致，活动页 200、主内容与预渲染标记通过。最终网页目标：Global `c102d0f93b5098868d4ba573-387db83f7b620ba396e2dfd8`；JP `c102d0f93b5098868d4ba573-16f45a4957be38445dbe07d6`。

## 切换前基线

- 前端代码：`564dbde7dc6a31d0c474ae25`。
- Global 内容：`ccc1b9da89a54c819c87609e`；JP 内容：`c4d668fa285e427ca446a762`。
- 网页指针：Global `564dbde7dc6a31d0c474ae25-d295ab0bd9d9a55b66fe2c2f`；JP `564dbde7dc6a31d0c474ae25-f28bf6543b45f303b97d2c48`。
- 检查时服务器可用 9,122,283,520 字节，预渲染服务上次成功、timer active。没有为本轮清理磁盘。

## 线上浏览器验收

使用独立浏览器会话和合成个人库存访问真实生产域名；未读取或改动用户个人浏览器库存。

- Global、JP × 简中、英文共四个更新记录页均显示 current；版本与卡数准确，索引分别 136/136、135/135；计算器明确显示参考估算、未实战核验。双服中文状态区截图已目视复查，无旧双列挤压。
- Global 正式截图入口：既有三张校准图识别 56 个完整区域，合并 38 张卡。校对 `member-card-61` 等级为 79 后保存成功；已有 `member-card-60` 的技能 4/3 与乐队道具总等级 5 保留。
- 撤销后序列化库存与操作前逐字一致。另一次保存后刷新，38 张卡、校对值及已有技能、账号养成保持一致。
- 在隔离浏览器拦截一次特征响应为损坏字节，面板显示“卡库特征文件不完整”、保存禁用；恢复真实响应并重试后就绪，库存未改变。
- JP 正式入口使用当前 `jp-prod-1-0-5-10059-d1d63b9ebc5f` 的 135 卡索引成功准备引擎；这不等于日文截图识别准确率验收。
- 完整成功导入期间记录 71 项 GET（含本地 blob 读取），无截图上传；页面统计旁路的既有 400 与外部 beacon 连接错误单列，不计为截图功能失败。

## 发布窗口中的异常与恢复

代码切换时，现有 timer 的旧轮次正在渲染。Global 旧代码产物被 superseded 检查拒绝，联合晋级因缺少有效 Global stage 安全退出；线上旧页面保持服务。既有 timer 自动接续下一轮，双服新代码联合晋级成功，没有手动补派、停止或取消任务。提前访问旧更新页的一次浏览器等待超时保留为窗口证据，最终四页验收在晋级后重新执行。

首次引擎准备停在卡面引擎阶段并超时，未进入识别或写入；点击重新准备约 7 秒成功，各引擎资源返回 200。首轮未取得完整网络证据，原因未定，不归因为已证实的网络故障。随后自动化会话曾落到 about:blank，恢复页面与合成基线后完整识别、保存、刷新、撤销及故障重试均通过；没有为此更改业务代码、放宽校验或延长生产超时。

最终交付检查时服务器可用 7,064,993,792 字节；本批实际发布预算通过，未清理磁盘。回退代码、内容基线与镜像 digest 保留。此次上线完成不代表所有设备的首次加载稳定性已获认证。

## 证据边界

独立截图准确率、其他布局、真实手机性能、新游戏机制实战仍保留原边界；专用 GitHub Token、外部触发器与 Analytics 凭据继续暂缓。

原始证据：`/private/tmp/otonote-g-rollout-20261014`，包括镜像日志、回退基线、双服 final 日志、run-summary.json、public-functional-final.json、frontend-deploy.log、delivery-final.json、live-status.txt、live-import.txt、live-persistence.txt、live-retry.txt、live-jp.txt 和状态截图；私有配置不进入仓库。
