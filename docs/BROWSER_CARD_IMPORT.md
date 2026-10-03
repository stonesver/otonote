# 浏览器截图导入

入口为「我的养成」及配队工具共享卡库的「截图导入」。图片只送入本地 Web Worker，服务端提供不可变静态引擎和卡库索引；不提供图片上传或 OCR API。

## 用户行为

- 选择横屏原始列表截图，自动判断类型；不确定时使用每张图下方的原生下拉框更正：角色等级、角色特训或留影。当前网格适配每行 6 张角色 / 4 张留影，仅取完整卡牌；其他布局需另行校准。
- 同卡多图按卡牌 ID 合并。等级页和特训页互补；同字段不同值需显式确认。低置信度卡面不默认选中，未读出数值不猜测。
- 角色特训对应内部 `awake`（影响等级上限），觉醒星数对应 `rank`；留影花瓣对应 `rank`。
- 新角色的演出 / 激奏技能默认 1。可将勾选角色的两种技能一键设为 5，也可恢复默认：新卡 1，已有卡保留原值。
- 保存前检查当前区服、内容版本、卡牌身份与真实养成上限。已有卡缺少观测值的字段不变，新卡必须补全等级及阶数。确认一次性合并，复用原卡库撤销；账号养成和未选卡不受影响。
- 关闭、取消或离开页面释放 Worker 和本地截图 URL。失败可重试，未确认前不写入卡库。

## 代码与内容交付

`npm ci --prefix site` 从锁文件安装识别引擎。独立前端构建把引擎与许可证放入 `compiled/recognition/`，由代码版本路径缓存；正常浏览卡库不请求这些引擎。打开截图导入面板后，后台准备卡面引擎、索引及数字模型，显示各阶段真实状态；可同时选择截图。关闭后释放 Worker。

特征索引是独立内容产物，不能提交到源码。只在离线构建环境安装 OpenCV Python、NumPy、Pillow，然后从本次候选的目录生成：

```sh
python -m pip install -r tools/card-recognition-requirements.txt
python -m tools.card_recognition \
  --catalog /PRIVATE_CANDIDATE/REGION/RELEASE/generated/releases/RELEASE/zh-CN/catalog.json \
  --media-root /PRIVATE_CANDIDATE/REGION/RELEASE/public \
  --out output/card-recognition-NEW_RELEASE
```

构建输出 `card-recognition.json` 与 `features.bin.gz`，包含版本、区服、算法、范围与 SHA-256。发布时显式提供索引目录：

```sh
python -m tools.content_publication \
  --candidate /PRIVATE_CANDIDATE \
  --store /PRIVATE_CONTENT_STORE \
  --recognition-index output/card-recognition-NEW_RELEASE
```

线上定时更新器可在私有 `contentPublication` 设置中启用 `cardRecognition: true`；运行环境须安装上述 Python 依赖。更新器按封存候选身份缓存索引，生成或校验失败时停止发布，不把缺索引的新版本覆盖到线上。

也可在候选封存前将两文件纳入 `supplemental-data/card-recognition/`，发布器默认识别该目录。不要修改已封存的候选或快照。索引必须随对应内容版本重建，发布器检查版本、哈希、解压大小、特征范围及卡牌归属，并将索引纳入新内容快照身份。没有索引的内容仍可发布，界面明确显示截图识别未提供，不回退其他版本。

原型和本地预览不等于线上发布；上线还需要对应区服的索引、正式候选门禁及部署验收。静态文件是否由 Cloudflare 缓存取决于线上域名代理和缓存策略，本功能不修改真实配置。

## 本地验证

```sh
node --test site/tests/card-recognition.test.mjs
python -m unittest tests.test_content_publication
bash scripts/build-web-client.sh --preview output/NEW_PREVIEW
```

浏览器验收使用真实截图检查匹配、缺失数字、合并、技能默认及满级、确认保存、刷新、撤销、取消后重试。检查网络日志只有静态识别资源 GET，无截图 POST。手机性能和不同分辨率布局需使用对应设备、样本另测。

## 按乐队填写道具总等级

个人养成和配队计算支持 `account.bandItemTotals` / `modifiers.bandItemTotals`，以乐队 Master ID 为键保存整数总等级。由 `band-item-totals.mjs` 验证当前规则中同乐队所有道具的效果类型、目标与每级增量相同且线性，才开放简化输入；范围取各道具等级上限之和。

总等级覆盖同乐队的单件加成，不重复叠加；不伪造或删除原始 `bandItems` 记录。清空总等级会恢复使用单件记录，修改单件时清除对应乐队的总等级覆盖。新导入的完整游戏道具记录会替代旧总等级；未观测到道具时仍保留它。字段随个人备份和配队分享链接保存。
