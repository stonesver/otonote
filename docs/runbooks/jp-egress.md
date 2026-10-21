# JP Version 接口出口

指定代理只作用于允许的 Version RPC，CDN／R2 仍沿各自正常路径。TLS 校验始终开启，403 或非零 gRPC 状态仍阻断；不自动换端点或把旧版本当成最新。客户端身份和升级另见[JP 升级契约](../reference/jp-client-upgrade.md)。

## 两种互斥配置

- `OURNOTES_JP_VERSION_PROXY`：外置的 HTTP／HTTPS／SOCKS 代理地址。
- `OURNOTES_JP_PROXY_NODE`：单个私有节点 JSON，由摘要固定的 mihomo 临时启动。不能与前一变量同时设置。本机回环地址不能直接作为托管 runner 的远程出口。

```sh
python3 -m tools.jp_version_egress --binary /PRIVATE_TOOLS/mihomo -- producer-command arguments
```

节点仅接受 `type: trojan`、server、整数 port、password、可选 name／sni／udp、`skip-cert-verify: false`、tcp／grpc network；grpc 必须提供固定 `grpc-opts`。未知或重复字段拒绝。实际 JSON 保存在受保护环境，不能进入仓库。

helper 替换节点名、禁用 UDP，固定监听 `127.0.0.1:17897`，不启用 LAN、TUN、DNS、controller、订阅或外部规则。仅允许固定 Version 主机，其余代理流量拒绝。生产子进程只接收本机代理 URL，不接收节点 Secret；代理本身也不接收 R2 凭据。该限制作用于此监听器，不是生产进程所有网络流量的操作系统沙箱。

## 生命周期与验证

临时目录 `0700`，配置与日志 `0600`；错误输出不包含节点数据或客户端日志。正常退出、失败和可处理信号清理进程组与临时文件；SIGKILL 无法保证清理，因此用于临时 runner。容器使用此本机节点时按工作流契约配置 Linux host networking。

监听器就绪不等于 RPC 可用。使用 **Probe JP version through configured egress** 先验证受信 metadata 摘要，再执行有界 Version 请求；探测不写 R2、不启用定时器。只保留脱敏状态，去掉 URL、令牌形态、凭据赋值和控制字符，不记录认证头和响应体。完整生产期间代理退出则终止生产，shadow 与公开晋级另行验收。

节点与凭据变更前保存必要恢复配置，按最小授权更新。回退恢复对应代理模式及配置，重新探测；不能以历史成功记录证明当前出口可用。
