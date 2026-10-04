# 抽卡记录

入口为工具中的「抽卡记录」。支持港澳台 BHK 邮箱登录。每次查询重新认证，只保留当前页面内存中的本次结果；刷新、离开、重新查询或主动清空均销毁结果。无历史合并、账号数据库、浏览器备份或服务端下载接口。

## 读取与部署

沿用 `tools.growth_web` 的同源、nonce、限流和并发边界。`GET /api/growth-export/capabilities/` 增加 `gachaHistory: true`；`POST /api/growth-export/gacha-history/` 只接受 account/password，返回不含凭据的 snapshot。每次调用复用登录代码建立短期认证后读取 History；不调用抽卡或兑换方法。原养成客户端的白名单不变。

部署网关时需要一起包含 `tools/gacha_history.py`，原 `/api/growth-export/` 反向代理配置可直接覆盖新路由，维持 no-store 与禁止磁盘缓冲。代码与内容仍独立发布：重新生成 `global-systems.json` 后，`gachaHistoryPrizes` 提供 MasterGachaPrize ID 到资源类型、资源 ID、奖品组和 UP 标识的映射。旧快照缺少映射时仍能查看数量和卡池，但奖品标为未识别、暂停欧非评价，不能猜卡牌。

响应最多 2,000 个新式批次、10,000 个奖品；旧版单条记录最多 10,000 条。protobuf 解析沿用 16 MiB 上限。超限、重复单值字段、类型不符、非法 ID、无奖品批次或仅包含不认识字段的响应均拒绝，不悄悄展示截断结果。空 protobuf 是合法的零记录响应。

## 静态协议证据

来自 Global Android 1.0.1 (25) 的已还原 IL2CPP v39 元数据及原生序列化代码。这是协议实现依据，不等同于新功能已完成当前实服账号对账。客户端版本请求头继续由 `tools.growth_login.CLIENT_VERSION` 统一控制。

- 服务名为 `app.gacha.GachaService`，只读方法为 `History`。
- `App.Protobuf.Gacha.HistoryRequest` 无请求字段。原生 InternalWriteTo 仅处理 unknown fields；没有分页游标，不凭空构造分页参数。
- `HistoryResponse`：字段 1 为 repeated GachaHistory；字段 2 为 repeated GachaExecutionHistory。
- `GachaExecutionHistory`：1 gacha_id int64，2 product_id int64，3 free_gem int32，4 paid_gem int32，5 ticket int32，6 executed_at int64，7 repeated GachaPrizeHistory。导出只取 1、2、6、7，不导出消费或账号资料。
- `GachaPrizeHistory`：1 prize_id int64，2 converted bool。
- 旧版 `GachaHistory`：1 prize_id int64，2 gain_at int64，3 converted bool。无卡池信息，显示为未归属卡池。
- `GachaExecutionHistoryExtensions.GetExecutedDateTime` 的原生转换链以 10,000,000 ticks/second 换算 Unix 时间，使用秒而非毫秒。页面日期统一按 UTC+8 显示。
- 新旧两个数组不相加：有 execution_history 时优先采用它，否则采用旧版。没有稳定记录 ID，不能用相同时间、奖品或卡池去重，同批重复奖品也保留。

元数据常量名与原生 wire tags 交叉核对；相关方法地址为 HistoryRequest.InternalWriteTo `0x588e794`、HistoryResponse.InternalWriteTo `0x588f008`、GachaExecutionHistory.InternalWriteTo `0x5760164`、GachaPrizeHistory.InternalWriteTo `0x5760e5c`、旧 GachaHistory.InternalWriteTo `0x575f650`。这些地址只用于上述客户端版本的研究复现，不是运行时配置。游戏包和元数据不随源码分发。

## 统计和分享

抽数按返回奖品条目计，SSR=稀有度 4，EX=10，BD=20。三者合计为高稀有卡；成员卡与留影的相同资源 ID 分开解析。UP 只有在奖品组属于对应卡池时才判定。未知卡池不丢弃；未知奖品或卡牌资料不完整时暂停称号定级。

趣味称号只描述本次高稀有卡比例：≥10% 欧皇附体、≥5% 小欧怡情、≥2% 平稳发挥、其余非酋渡劫。不足 20 抽不定级。包含保证抽取，不表示官方概率、玩家排名、统计显著性或下次出货预测。明细的种类和稀有度筛选不改变成绩单，避免选择 SSR 后生成虚假的 100% 出货率。

卡池与日期筛选改变成绩单及分享范围。图表包括稀有度分布、各池抽数与最近 30 个有记录日期的抽数。同批内顺序未核实，不显示单抽顺序或保底进度。

PNG 由浏览器本地 Canvas 根据聚合字段白名单绘制，不截取登录表单，不调用截图服务器，不包含邮箱、账号 ID、凭据或逐条抽取时间。预览后下载，图片不会自动发布。关闭预览、修改统计范围或离开页面时释放图片 URL。

## 验证

`tests/test_gacha_history.py` 覆盖协议与读取白名单；养成网关及预览代理测试覆盖独立登录、同源校验与 no-store；`site/tests/gacha-history.test.mjs` 覆盖重复奖品、卡池归属、未知数据、UTC+8、称号及分享字段边界。浏览器验收使用明确的合成历史，不冒充真实账号。

2026-10-05 本地验证：46 项 Python 回归、44 项前端统计/导航/启动/预渲染回归通过；独立网页构建及产物摘要校验通过。Playwright 使用合成的两池 150 条记录验证分池统计、明细筛选不改变成绩单、日期错误处理、320/390 像素布局、主动清空、重复登录不叠加、登录失败不留旧结果、刷新和离页清空，以及本地 PNG 下载；已检查导出的 1080 × 1620 图片无裁切。源码凭据扫描无发现。

真实验收仍需用本人账号登录，并与游戏内同一时段的批次、数量、奖品及时间核对；官方实际保留期限未知，页面始终说明仅含本次返回记录。
