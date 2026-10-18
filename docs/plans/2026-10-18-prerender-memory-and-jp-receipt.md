# 预渲染内存与日服回执依赖修复

## 已复现的失败

- 源站国际服和日服英文页面均在 Node `--max-old-space-size=384` 下报 `JavaScript heap out of memory`，中文页面已生成；两服暂存 HTML 未晋级，旧页面继续服务。容器本身保留 1 GiB 内存 / 1.5 GiB 含 swap 的总限额。
- JP R2 运行 39105869900 已完成内容生成和上传读回，但在宿主机 `Record verified production receipt` 阶段因缺少 pyelftools 退出。新动态 JP 绑定校验导入 MetadataV39；生产镜像包含该依赖，但宿主只安装 r2-requirements。干净环境仅安装该 requirements 后，同一真实 1.0.6 metadata 绑定读取复现错误。

## 最小方案

1. 暂停预渲染 timer，等待正在运行的任务自然结束，避免反复 OOM；当前线上目录与其他服务不变。
2. 在原容器资源上限内，用 512 MiB Node 堆对当前两服英文页面做隔离验证，记录子进程峰值 RSS；成功后调整发布器默认堆上限。仍按语言、区服串行生成，保持完整校验和双服暂存晋级。
3. r2-requirements 显式固定 pyelftools==0.32，确保日服轻量恢复/生产回执和镜像共用一致依赖。使用干净宿主依赖环境重验动态绑定，不以开发环境通过替代。
4. 修复先合入今日集成分支；发布仅携带本修复，避免夹带其他未发布任务。经 PR/CI 后构建受审预渲染镜像，校验 artifact、镜像 ID 与源码版本，保留旧镜像及配置备份再切换。
5. 重新执行日服 R2；重新执行预渲染并恢复 timer。最终分别验收 Actions 晋级、R2 指针、源站 HTML 指针、外网两服页面实际引用。

## 回滚边界

预渲染发布失败保留旧线上 HTML；还原备份中的镜像 ID 和源码版本即可回退。不得放宽内存到无上限、绕过回执校验、直接修改公开指针或删除历史内容。临时验证目录及镜像归档仅在验收后按确切路径清理。

## 本地和源站隔离验证

- 旧 384 MiB 设置的真实失败日志已保存于服务器 journal；512 MiB 在同一固定旧镜像、同一 sealed renderer 和当时 R2 指针下，分别生成 Global 英文 815 页、JP 英文 787 页，均校验 codeId/pointer。子进程累计峰值 RSS 560944 KiB（约 548 MiB）；原 1 GiB 容器硬限制不变。只写 `.memory-probe-20261018`，未改线上 HTML 指针。
- 干净 Python 环境仅安装旧 r2-requirements 后，真实 JP 1.0.6 load_binding 失败于 pyelftools；补齐固定版本后同一调用通过。此前 CI 的额外安装掩盖了生产宿主缺依赖的差异。
- 72 项测试通过：prerender_publication、r2_prerender_promotion、r2_production_gate、jp_auto_upgrade、runtime_bundle；diff 检查通过。
- 原预渲染 timer 已临时停止，最后服务状态 failed；部署验收后必须重新启动 timer。旧线上页面始终保留。
