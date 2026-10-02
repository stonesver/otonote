# 参与 OtoNote

欢迎通过资料纠错、使用反馈、文档和代码改进帮助完善 OtoNote。普通反馈不需要搭建开发环境。

## 资料纠错与问题反馈

在 [GitHub Issues](https://github.com/stonesver/otonote/issues) 提交前，可以先搜索是否已有相同问题。建议包含：

- 页面链接、条目名称或 ID，以及国际服/日服等实际区服信息。
- 游戏版本、站点资料版本；后者可在网站更新记录中查找。
- 操作步骤、期望结果、实际结果，以及设备和浏览器。
- 可公开核对的依据或已遮去账号信息的截图。

不要上传游戏安装包、整套素材、真实数据库、账号导出、密码、令牌、有效 SDK 配置或生产日志。安全问题、权利反馈和需要私下核对的信息请通过 [lhystone@qq.com](mailto:lhystone@qq.com) 联系维护者。

## 文档与代码修改

首次阅读代码可从[技术概览](docs/TECHNICAL_OVERVIEW.md)开始。较大的功能或架构调整建议先在 Issue 中说明问题、使用场景和预期范围；小的文档或拼写修正可以直接提交 PR。

每项工作使用独立分支，并保留他人未完成的修改。PR 应说明具体问题、修改后的行为、验证结果及仍未验证的部分。涉及界面时附上桌面和手机宽度的截图；涉及数据规则时提供最小合成样例与可核对的来源。

项目自有代码与随附文档采用 [MIT License](LICENSE)。提交贡献前请确认自己有权按 MIT 许可提供相应内容，并阅读[源码与许可](docs/LICENSING.md)。如引入第三方实现，应保留来源、版权和适用许可；不要将无权提供的代码或素材放入 PR，也不要将游戏资源或第三方软件重新标记为本项目的 MIT 许可。

## 安装与基础验证

使用 Node.js 22.22.0（见 `.nvmrc`）和 Python 3.11+。从仓库根目录执行：

```sh
nvm use
npm --prefix site ci
node --test site/tests/story-share.test.mjs site/tests/startup.test.mjs site/tests/independent-content.test.mjs site/tests/loading-shell.test.mjs
python3 -m unittest tests.test_item_acquisition tests.test_game_database tests.test_code_publication -q
bash scripts/build-web-client.sh --preview output/contribution-preview
python3 -m tools.code_publication --source output/contribution-preview --verify-only
```

构建输出目录必须尚不存在；再次验证请使用新的目录名。以上是公开源码的基础离线验证，不代表完整测试或生产验收。根据修改范围补充相关检查，正式候选必须通过[开发流程](docs/DEVELOPMENT_WORKFLOW.md)规定的固定验证。

完整页面预览还需另行提供内容快照；部分测试依赖未随仓库分发的游戏数据、Python 依赖或服务。没有这些条件时，明确写出未运行的检查，不要把缺失输入时的构建通过当作实机或线上验收。

## 文档和依赖一起维护

| 修改内容 | 同步更新 |
| --- | --- |
| 使用流程或功能入口 | `docs/USER_GUIDE.md`，必要时更新关于页面 |
| 模块职责、构建或运行方式 | `docs/TECHNICAL_OVERVIEW.md` 与对应开发文档 |
| 第三方依赖、字体或运行库 | 锁文件/依赖清单、`THIRD_PARTY_NOTICES.md` 与 `site/src/lib/project-credits.ts` 中受影响的条目 |
| 许可或公开范围 | `docs/LICENSING.md`、`docs/PUBLIC_SOURCE.md`、README 与关于页面 |
| 公开联系方式 | `site/src/lib/site-contact.mjs` 与引用这些信息的文档 |

关于页面保留中文与英文；新增文字时同步维护两种语言。页面内站内链接使用现有区服/语言路径规则，避免切换到错误的内容版本。

真实配置和发布资料继续留在仓库外。提交前按[配置与脱敏边界](docs/CONFIGURATION_POLICY.md)检查变更；PR、构建产物或截图中也不要携带私有信息。提交 PR 不会自动部署线上站点。
