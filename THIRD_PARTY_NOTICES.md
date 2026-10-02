# 第三方项目、依赖与致谢

感谢以下项目与维护者。本文记录 OtoNote 实际声明或调用的主要第三方项目、用途和许可来源，核对日期为 **2026-10-03**。项目自有代码的许可状态另见[源码与许可说明](docs/LICENSING.md)。

这是一份来源索引和许可摘要，不是完整的软件物料清单（SBOM），也不替代原始版权声明、许可证或发行包中的 NOTICE。依赖版本发生变化时，应重新检查随该版本提供的文件；不能把这里的许可名称视为对整个项目的统一授权。

## 网页与构建

版本来自 [`site/package-lock.json`](site/package-lock.json)，直接声明见 [`site/package.json`](site/package.json)。许可证名称同时核对了已安装包的元数据；上游链接用于阅读原文，分支上的文档可能随上游更新。

| 项目 | 当前锁定版本 | 在本项目中的用途 | 许可与来源 |
| --- | --- | --- | --- |
| [Astro](https://astro.build/) | 7.1.0 | 页面模板与静态投影构建 | MIT；[LICENSE](https://github.com/withastro/astro/blob/main/LICENSE) |
| `@astrojs/check` | 0.9.9 | Astro / TypeScript 检查 | MIT；[项目](https://github.com/withastro/language-tools) |
| `@astrojs/compiler` | 2.13.1 | Astro 编译工具 | MIT；[LICENSE](https://github.com/withastro/compiler/blob/main/LICENSE) |
| [TypeScript](https://www.typescriptlang.org/) | 6.0.3 | 页面逻辑、类型与编译工具 | Apache-2.0；[LICENSE](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt) |
| [Three.js](https://threejs.org/) | 0.162.0 | 演出场景 WebGL 渲染 | MIT；[LICENSE](https://github.com/mrdoob/three.js/blob/r162/LICENSE) |
| [PixiJS](https://pixijs.com/) | 7.4.3 | Live2D 预览的二维渲染 | MIT；[LICENSE](https://github.com/pixijs/pixijs/blob/v7.4.3/LICENSE) |
| [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) | 0.5.0-beta | PixiJS 与 Live2D 的集成 | MIT；[LICENSE](https://github.com/guansss/pixi-live2d-display/blob/master/LICENSE) |
| `@esotericsoftware/spine-threejs` | 4.2.67 | Spine 动画与 Three.js 的集成 | Spine Runtimes License Agreement；[上游许可](https://github.com/EsotericSoftware/spine-runtimes/blob/4.2/LICENSE) |
| [PostCSS](https://postcss.org/) | 8.5.25 | 样式构建依赖 | MIT；[LICENSE](https://github.com/postcss/postcss/blob/main/LICENSE) |

独立网页构建脚本还直接调用了锁文件中的 `esbuild`（0.28.1，MIT，[来源](https://github.com/evanw/esbuild/blob/main/LICENSE.md)）和 `@astrojs/compiler-rs`（0.3.1，MIT，许可记录见安装包）。Spine 同时依赖 `@esotericsoftware/spine-core` 4.2.67，仍适用 Spine 专门许可。其余传递依赖以锁文件和实际包内声明为准，不在这份摘要中逐项展开。

当前安装的 Spine 4.2.67 包中 `LICENSE` 标注日期为 2019-05-01；上游 4.2 分支上的许可文本已更新。核对或再分发时应保留实际使用版本的原始许可与版权声明，不能只用当前分支网页替代包内文件。

## Python 服务与图片渲染

声明入口为 [`requirements-query.txt`](requirements-query.txt)、[`requirements-admin.txt`](requirements-admin.txt) 和 [`requirements-qqbot.txt`](requirements-qqbot.txt)。下列版本页面由上游维护者提供元数据。

| 项目 | 声明版本 | 用途 | 许可与来源 |
| --- | --- | --- | --- |
| FastAPI | 0.128.8 | 查询、管理与机器人 API | MIT；[版本与许可](https://pypi.org/project/fastapi/0.128.8/) |
| Uvicorn | 0.39.0 | ASGI 服务运行 | BSD-3-Clause；[版本与许可](https://pypi.org/project/uvicorn/0.39.0/) |
| HTTPX | 0.28.1 | 服务间 HTTP 请求 | BSD-3-Clause；[版本与许可](https://pypi.org/project/httpx/0.28.1/) |
| Pillow | 11.3.0 | 机器人回复图片绘制 | MIT-CMU；[版本与许可](https://pypi.org/project/Pillow/11.3.0/) |
| cryptography | 50.0.1 | 机器人服务所需密码学功能 | Apache-2.0 OR BSD-3-Clause；[版本与许可](https://pypi.org/project/cryptography/50.0.1/) |

管理服务复用查询服务的依赖声明。Python 的 `sqlite3` 模块用于访问 SQLite；SQLite 核心以 [public domain](https://sqlite.org/copyright.html) 方式提供，具体运行版本取决于 Python 环境。

## 资源处理、研究与本地导出

依赖入口为 [`requirements-worker.txt`](requirements-worker.txt)、[`analysis/requirements.txt`](analysis/requirements.txt)、[`analysis/crypto/requirements.txt`](analysis/crypto/requirements.txt)、[`tools/growth-export-requirements.txt`](tools/growth-export-requirements.txt) 和 [`packaging/growth-tool/requirements.txt`](packaging/growth-tool/requirements.txt)。这些工具不都在浏览器或查询服务中运行。

| 项目 | 声明版本 | 用途 | 许可与来源 |
| --- | --- | --- | --- |
| UnityPy | 1.25.2 | Unity 资源解析 | MIT；[版本与许可](https://pypi.org/project/UnityPy/1.25.2/) |
| tomli | 2.4.1；仅 Python < 3.11 | TOML 配置兼容读取 | MIT；[版本与许可](https://pypi.org/project/tomli/2.4.1/) |
| py3rijndael | 0.3.3 | 数据处理中的 Rijndael 运算 | MIT；[版本与许可](https://pypi.org/project/py3rijndael/0.3.3/) |
| pyelftools | 0.32 | ELF / DWARF 二进制解析 | public domain / Unlicense；内含 construct 另有许可，见 [LICENSE](https://github.com/eliben/pyelftools/blob/v0.32/LICENSE) |
| Unicorn | 2.1.4 | 原生代码行为与计分研究中的 CPU 模拟 | 核心 GPL-2.0，bindings 有 BSD 声明；见 [COPYING](https://github.com/unicorn-engine/unicorn/blob/2.1.4/COPYING) 及 [bindings](https://github.com/unicorn-engine/unicorn/tree/2.1.4/bindings)；不能只依据 PyPI 的 BSD 标签判断整个运行库 |
| WannaCRI | 0.3.1 | CRI USM 媒体解析与提取 | MIT；[版本与许可](https://pypi.org/project/WannaCRI/0.3.1/) |
| cryptography | 46.0.3 | 数据处理与本地导出中的密码学功能 | Apache-2.0 OR BSD-3-Clause；[版本与许可](https://pypi.org/project/cryptography/46.0.3/) |
| grpcio | 1.76.0 | 本地养成导出中的 gRPC 通信 | Apache-2.0；[版本与许可](https://pypi.org/project/grpcio/1.76.0/) |

不同角色环境使用不同版本的 cryptography 是当前依赖声明的实际情况；本文不合并或调整这些环境。二进制轮子还可能携带其他原生组件，应保留其随包提供的许可。

## 外部运行库与媒体工具

| 项目 | 用途与提供方式 | 许可来源 |
| --- | --- | --- |
| Live2D Cubism Core | Live2D 播放所需运行库；公开仓库不附带，需另行取得 | [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)；另见[本地说明](site/public/vendor/live2d/NOTICE.md) |
| FFmpeg / FFprobe | 音视频转码、封装与校验，由运行环境提供 | 通常以 LGPL 为基础，启用特定组件后涉及 GPL 等条款；以所用二进制构建为准，见[官方说明](https://ffmpeg.org/legal.html) |
| vgmstream | CRI 等游戏音频解码，由运行环境另行提供 | [COPYING](https://github.com/vgmstream/vgmstream/blob/master/COPYING) 与实际构建所含组件的声明 |

Live2D Core 与 `pixi-live2d-display` 是不同组件；后者的 MIT 许可不覆盖前者。游戏模型、动画、音乐和图片同样不属于这些代码依赖授予的许可范围。

Node.js、Python、容器基础镜像、系统软件包及反向代理由开发/运行环境提供，各自依赖和许可还应以实际使用的发行版为准；本文不声称覆盖镜像或便携工具包的全部组成。

## 字体与站点素材

- **Noto Sans Symbols 2**：机器人图片的符号回退字体；[上游](https://github.com/google/fonts/tree/main/ofl/notosanssymbols2)，SIL Open Font License 1.1；原文保留在 [`backend/qqbot/fonts/OFL.txt`](backend/qqbot/fonts/OFL.txt)。
- **Noto Sans Symbols**：机器人图片的补充符号字体；[上游](https://github.com/google/fonts/tree/main/ofl/notosanssymbols)，SIL Open Font License 1.1；原文保留在 [`backend/qqbot/fonts/OFL-Symbols.txt`](backend/qqbot/fonts/OFL-Symbols.txt)。
- **Noto CJK**：机器人容器通过系统的 `fonts-noto-cjk` 软件包取得；[上游及许可](https://github.com/notofonts/noto-cjk)。字体文件未作为公开源码提交，分发时保留所用软件包的声明。
- 网站 CSS 中的 Iowan Old Style、Avenir Next、宋体、微软雅黑等是系统字体回退名称，不代表仓库附带或重新授权这些字体文件。
- 站点原创标识与游戏素材分开管理。游戏素材、官方 SDK、Live2D Core 和内容快照不随公开源码分发；网站展示不改变其权利归属。

## 如何维护这份清单

更新依赖时一并核对版本、用途、上游来源、包内许可证及额外 NOTICE。网页展示的主要项目位于 [`site/src/lib/project-credits.ts`](site/src/lib/project-credits.ts)，应与本文一致。

分发构建后的网页、镜像或便携工具包时，还需根据**实际包含的文件**保留第三方声明与适用许可；不要将本清单当作已完成全部传递依赖和二进制分发义务核验的证明。
