# 浏览器截图识别原型

纯静态、独立的截图识别工作台。用户选择本地图片后，OpenCV.js 在 Worker 中匹配卡面，Tesseract.js 在另一个 Worker 中读数字；截图不上传。支持逐卡校对、跨图合并、字段冲突检查、取消重试和导出观察草稿。**尚未接入正式个人卡库或正式发布流程。**

## 本地运行

环境：Node/npm、Python 3、`numpy`、`Pillow`、`opencv-python-headless`。构建时明确传入卡库和媒体根；脚本不读取真实配置或线上凭据。

```sh
python3 tools/browser_card_import/setup_vendor.py --out output/card-import
python3 tools/browser_card_import/build.py \
  --catalog /PRIVATE_CONTENT/data/catalog.json \
  --media-root /PRIVATE_CONTENT \
  --out output/card-import
python3 -m http.server 4398 --bind 127.0.0.1 --directory output/card-import
```

访问 `http://127.0.0.1:4398/`。可给构建器增加 `--samples /TRAINING.jpg /LEVEL.jpg /SUPPORT.jpg`，按该顺序添加本地示例。资源、特征索引、截图、运行时依赖和生成结果仅落在被 Git 忽略的 `output/` 下；不要提交这些生成数据。`runtime/` 是依赖准备目录，正式发布静态产物时须排除它和调试文件。

第三方版本：OpenCV.js 4.13.0、Tesseract.js 7.0.0，npm 依赖以锁文件固定；OpenCV 脚本及 English `best_int` 模型用 SHA-256 固定。浏览器只请求本站静态文件，运行时不连接 CDN。准备脚本下载公开依赖并输出 `vendor-manifest.json`；完整本地包包含多个 WASM 兼容版本，浏览器按能力选择需要的版本，不会全部加载。

## 识别与数据边界

- 将截图宽度归一到 1280，使用样本校准的角色 6 列 / 留影 4 列网格；底部不完整卡片跳过。任意裁剪、滚动偏移、不同布局和真实手机性能尚未验收。
- 离线为角色 450px / 留影 300px 卡面生成 ORB 特征。浏览器用多表 Hamming 近似检索筛选 6 个候选，再用完整特征匹配和 RANSAC 几何验证。接受阈值是启发式证据数，不是准确率或概率；仍需人工核对。
- 数字经过亮色字形分离，再进行 OCR；低置信度或多次读数不一致留空。角标按固定采样点读取点亮数；其它分辨率、主题、零阶状态尚需补充样本。
- 草稿字段为游戏语义：`training`（特训）、`awakeningStars`（觉醒星数）、`supportPetals`（留影突破）、`level`。看不见的技能等级保持缺失。这里不调用正式库存写入接口、不生成整库替换备份。
- 正式接入时需保留现有内部语义：角色 `training → awake`，角色星数及留影花瓣 `→ rank`。特训决定角色等级上限。接入前需要版本/区服校验、养成上限验证、已有库存合并与用户确认。
- 索引记录内容版本、区服和特征摘要；运行时校验摘要绑定。缺卡应补对应内容资源，不能自动选最相近的错卡。
- Worker 负责识别重计算；主线程处理小数字裁片与结果 UI。设置 12 张、单张 12 MiB、解码后 2000 万像素限制。生产接入前还需完善解码前尺寸验证、内存预算和索引缓存。

## 验证

```sh
node --test tools/browser_card_import/tests/*.test.mjs
```

本地内置 Chromium 在三张用户提供的**校准样本**上，56 个完整区域：49 个卡面正确匹配、7 个缺资源而拒绝、0 个错误接受；53 个数字正确、3 个留空；56 个星星/花瓣计数正确。49 个已匹配区域合并成 33 张不同卡。该结果不是独立测试集准确率。

复测整批约 5.2 秒，匹配约 1.4–1.6 秒/图；索引压缩后 4.25 MiB。数字引擎已有缓存，本地静态服务无公网延迟，因此不能据此承诺首次公网加载或手机耗时。真实文件选择单图流程约 1.7 秒。已验证取消重试、手动修改触发冲突、恢复一致值后导出按钮恢复、导出动作触发。单元测试覆盖跨图合并、缺失字段、非法 ID/数值、冲突与完整网格边界。

正式上线前仍需：接入最新内容快照、独立截图集、自动网格检测、真实 Android/iOS 浏览器验收及正式卡库草稿合并入口。
