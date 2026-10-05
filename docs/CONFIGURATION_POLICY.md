# 配置、脱敏与源码发布边界

真实配置仅保存在受保护的本地目录或服务器，不提交、不上传为 CI artifact、不写入发布清单。线上当前生效行为是初始迁移基线；例如内容更新在一次执行结束后等待两小时。此约定不授权用模板覆盖实际线上配置。

## 什么可以进入仓库

- 程序、测试、配置字段契约、仅含占位符的 `*.example.*` / `*.template.*` / `config/examples/` 模板。
- 公共产品定义 `config/site-product.json` 与精确列举的性能门槛，它们不包含部署地址、账号、凭据或运行状态。
- 共享计算包中的公开规则和小型合成测试数据。
- 精确列举的 `catalog/evidence/arena-client.json`：旧仓库已审阅的静态客户端结构说明，仅含符号、资源名称和历史旗标观测，不含凭据或部署配置。其余 `catalog/evidence/` 文件继续排除；该例外仍接受全部内容扫描。
- 通用 systemd / Docker / Nginx 部署模板。环境覆盖值、凭据和具体资源版本绑定必须留在仓库外。

运行输入计划、环境登记、SDK 身份文件、站点生成数据、游戏素材、原始验证报告、本地代理配置、依赖缓存和 Git 历史均不属于可发布源码。`config/` 中新增文件默认禁止，只允许模板及程序中明确列举的公共产品契约。

资源解码器的具体客户端版本、元数据摘要和字段映射属于实际运行配置，也保留在仓库外。程序必须校验版本与摘要绑定；不能把旧客户端的字段位置用于未知版本，也不能把密钥或真实映射复制到公共测试样例。仓库仅保留字段契约及合成样例。

模板只是结构示例。凭据字段使用 `replace-with-…`、`${VARIABLE}` 或空值；不得从实际配置复制值后仅改名为 `.example`。部署文件通常采用 root 专有目录（如 `/etc/ournotes/`）和 `0600` 权限；目录和字段结构可记录，真实值不能进入报告。SDK 文件应只读挂载到程序，不能 `COPY` 进镜像。

## 检查命令

```sh
# 默认检查即将提交的索引内容；工作区后来擦掉密码也不会绕过检查。
sh scripts/check-repository.sh --scope staged

# 发现遗留已跟踪的禁止文件。报告不包含命中的内容。
python3 tools/repository_hygiene.py scan --scope tracked \
  --report output/governance-private/hygiene-tracked.json

# 检查源码候选；工作区中被排除的实际配置可继续留在原地。
python3 tools/repository_hygiene.py scan --scope working \
  --report output/governance-private/hygiene-working.json

# 可选：启用提交前检查（影响当前工作副本）。
git config core.hooksPath .githooks
```

`.gitignore` 不能移除已跟踪的配置。先保存私有备份，再审查私有清单并执行逐文件 `git rm --cached`；禁止直接运行批量删除或上传旧历史。此工具只列出问题，不改变索引，也不删除实际文件。`tracked` 读取完整索引；`staged` 仅读取本次新增/修改文件的索引版本。

## 确定性源码导出

```sh
python3 tools/repository_hygiene.py export --root /path/to/reviewed-public-checkout \
  --source HEAD --destination /tmp/ournotes-reviewed-source
```

导出目标必须不存在且位于来源目录之外。可选择 `working`、`index` 或 Git 提交；正式交付使用明确提交。文件选择采用允许清单，再检查内容，拒绝符号链接与非普通文件。导出不携带 `.git`，不修改来源。`source-manifest.json` 记录路径、执行位、大小和 SHA-256；不记录时间、绝对路径、用户信息或配置值。相同来源得到相同文件清单与总摘要。清单是产物记录，不应再提交回源码形成自引用。

**导出成功不等于批准把私有工作区公开。** 现有公开仓库已移除游戏加密参数、运行资料、SDK 和私有研究报告，相关边界见其 `docs/PUBLIC_SOURCE.md`。后续必须在该公开工作副本上应用经过审查的必要改动；不能用本地整树覆盖已脱敏源码。既有公开仓库的 Gitleaks 历史检查继续保留，发布前还需审查 diff 与产物。

## 检查器能力与限制

内置检查拒绝实际配置路径、私钥、常见提供商令牌、JWT、含用户名密码的 URL、字面凭据与已知游戏加密参数。模板也接受相同内容检查。错误仅输出文件位置和规则，不显示命中片段、值或原始异常。指定 `--report` 的报告权限固定为 `0600`，终端只显示数量。

这是确定的提交/导出边界，不是通用 DLP：它不能证明自由文本、图片或任意编码数据没有隐私，也不会推断每个普通字符串是否为秘密。产品代码中的字符串、链接及用户批准公开的信息需要 diff 审查。扫描不通过时不要添加目录级豁免；内容规则仅对已审阅的合成测试值提供精确路径范围的例外。上列 Arena 静态证据只豁免路径选择，另以固定摘要约束原始字节，全部凭据检查仍生效。

密钥若曾公开，应在其真实来源处轮换；删除最新文件不能擦除 Git 历史。本轮不自动轮换凭据或改写历史。
