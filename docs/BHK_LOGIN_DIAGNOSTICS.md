# BHK 登录诊断日志

网页登录养成和抽卡记录共用 `/api/growth-export/` 网关。下述日志只帮助定位**启用后**的请求；此前关闭访问日志的时段无法回溯。

## 记录范围

- Nginx 专用访问日志 `/var/log/nginx/ournotes-growth.access.log`：UTC+8 时间、随机请求 ID、固定路由名、HTTP 方法和状态、请求与上游耗时。包括未到达网关的代理错误。现有 Nginx logrotate 每日轮转、保留 10 份。
- 网关容器标准输出：同一请求 ID、固定路由 `growth` 或 `gacha_history`、`start` / `stage` / `finish`、阶段、累计毫秒、结束状态和经过白名单过滤的错误码。正常处理的 POST 有开始与结束事件；若进程退出，可能只有开始与阶段事件。容器现有 `local` 日志驱动以 1 MiB × 2 文件限量，实际保留时长取决于请求量。
- 私有管理面板的「登录诊断」每分钟读取宿主机生成的快照，显示近 24 小时 POST 状态数、网关错误码和最近 50 条失败。快照合并当前及最近轮转的 Nginx 日志（兼容日期后缀与压缩文件），网关阶段来自容器日志；若容器日志已轮转或没有结束事件，阶段显示 `no_gateway_finish`。面板显示快照时间和首末请求时间，便于判断覆盖范围。
- 不记录邮箱、密码、玩家 ID、令牌、请求/响应正文、查询参数、请求头、IP、User-Agent、Referer、官方原始错误文本或异常堆栈。SDK 错误仅追加已识别的固定原因分类；未知文本记为 `unclassified`。请求 ID 由 Nginx 生成并传给网关；直接访问回环网关时，网关自行生成随机 ID。

## 排查

先按反馈时间在专用 Nginx 日志中找 POST 状态与 `requestId`，再用该 ID 查网关阶段：

```sh
grep '2026-10-08T06:' /var/log/nginx/ournotes-growth.access.log
docker logs --timestamps --since 2h ournotes-growth 2>&1 | grep '"requestId":"这里替换为日志中的ID"'
```

Nginx 有记录、网关无同 ID：检查代理到回环网关的连接。网关只有开始和阶段、没有结束：检查容器退出或正在等待的阶段。`finish` 的状态是网关尝试发送的响应，Nginx 状态才是代理对客户端的结果；两者不同可提示客户端中断。错误码用于区别官方 SDK、游戏登录、游戏读取、限流和输入拒绝。浏览器自身未发送请求时两层都没有相应 POST 记录；仍需用户提供准确时间和页面状态。

## 发布边界

新 `log_format` 位于 `deploy/nginx.conf.template` 的 HTTP 作用域，专用 `access_log` 与请求 ID 传递位于 `deploy/growth.locations.conf`。两项 Nginx 配置必须一起安装并通过 `nginx -t` 后再重载；网关镜像也需更新，才能看到阶段事件。合并源码本身不会启用线上日志。

管理面板快照导出器安装到 `/srv/ournotes-admin/growth_diagnostics_snapshot.py`，两个 systemd unit 安装到 `/etc/systemd/system/`。统计服务的私有配置中，目标站点增加 `"growthDiagnosticsFile": "/logs/growth-diagnostics.json"`；该路径只读挂载自 `/var/log/ournotes-stats`。先运行一次 service 确认 JSON 无敏感字段，再重启统计和管理服务、启用 timer。统计容器不接触 Docker socket，公开 `/events` 不提供读取诊断的能力。

网关全局启动上限为每滚动 60 秒 24 次、并发处理 2 次。HTTP 429 在面板中单独统计；出现持续 429 时应结合时间段和网关 `busy` / `rate_limited` 错误码判断，不能用页面浏览量推算登录压力。`sdk_service_500002` 是官方 SDK 返回的非零服务码，代码本身没有经核实的业务定义；只有匹配到已知安全提示时才显示原因分类。
