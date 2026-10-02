# 源码、开源许可与内容权利

OtoNote 的[源码仓库](https://github.com/stonesver/otonote)已公开，项目自有代码与随附文档采用 [MIT License](../LICENSE)。本文说明适用范围，许可原文以根目录 `LICENSE` 为准。

## 自有代码与文档

除另有声明的第三方部分外，本项目自有代码与随附文档采用 **MIT 许可证**。你可以按照许可证使用、复制、修改、合并、发布、分发、再许可或销售软件副本，并在副本或实质性部分中保留版权声明与许可声明。

软件按许可证所述的“原样”提供，不附带保证。完整授权条件与责任条款见 [LICENSE](../LICENSE)。MIT 许可不覆盖游戏资源、官方 SDK、第三方运行库或字体，也不替代它们各自的使用要求。

## 已有独立许可

本地养成导出工具继续保留 [`packaging/growth-tool/LICENSE`](../packaging/growth-tool/LICENSE) 中已有的 MIT 许可证与版权声明。该目录的[说明](../packaging/growth-tool/README.md)将许可范围限定为工具代码，不覆盖官方 SDK、游戏资源或第三方依赖。

如使用该工具代码，应同时保留它原有的版权与许可声明。项目其他自有代码与文档的 MIT 授权由根目录 `LICENSE` 提供。

## 第三方软件与字体

项目使用的第三方代码、工具和字体遵循各自许可。项目名、用途、当前版本和许可来源集中记录在[第三方项目说明](../THIRD_PARTY_NOTICES.md)。这份清单用于查找来源，不替代上游原始许可、版权声明或实际发行包内的 NOTICE。

需要单独区分的项目：

- **Live2D Cubism Core**：不随公开源码提供，使用者需按[官方专有软件许可](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)另行取得并核对适用条件。`pixi-live2d-display` 的 MIT 许可不覆盖 Core。
- **Spine Runtimes**：使用 [Spine Runtimes License Agreement](https://github.com/EsotericSoftware/spine-runtimes/blob/4.2/LICENSE)。以实际安装版本随附的许可为准，不能作为普通 MIT 依赖处理。
- **FFmpeg 与 vgmstream**：属于媒体工具链。应核对实际二进制的构建选项、包含组件及对应许可；单独列出项目名不代表发行包的全部依赖已经完成核验。
- **Noto 字体**：已保留的字体许可位于 [`backend/qqbot/fonts/`](../backend/qqbot/fonts/README.md)。系统字体与另行取得的字体文件按其自身许可处理。

## 游戏内容与公开范围

BanG Dream! Our Notes 的游戏名称、角色、图片、音频、剧情、模型等内容的权利归各自权利方所有。本站是非官方玩家资料站，不代表游戏官方；第三方名称和链接用于说明来源，不表示授权、合作或背书。

公开仓库提供应用源码、工具、测试、示例配置与原创站点标识，不附带游戏安装包、游戏素材、内容快照、生产数据库、账号资料、私有部署配置或资源解密参数。完整范围见[公开源码边界](PUBLIC_SOURCE.md)。

网站展示、可下载或可生成分享图，不等同于将相应游戏素材重新许可给访问者。本项目的源码公开、子工具许可与用户自己的账号授权，也不替代游戏权利方对素材、SDK 或接口使用的要求。

## 联系与权利反馈

对许可范围有疑问，或认为本站内容需要更正或移除，可通过 [lhystone@qq.com](mailto:lhystone@qq.com) 联系维护者。请提供具体页面或文件链接、涉及的内容及可以核对的依据；涉及个人信息或未公开材料时请使用邮件，不要提交到公开 Issue。
