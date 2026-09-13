# Ticket05 实施证据

日期 2026-09-14；基线 `fb7b1082a0fccee497ec3deea40505fc191f74ea`。工作区 `O:\GenesisCode\AtomicAgent`、main；新上下文 implement agent，仅本票产品 writer。用户批准 seam：A 发布预览、公开配置命令 API、普通 Run 固定选择、重启／权限／并发／故障边界。

## RED → GREEN

1. 新公开配置 API 返回 404，首个配置测试失败；实现独立环境／模型登记、预览发布、普通 Run 固定修订与持久历史后通过。
2. provider 路由 seam 因模块不存在失败；实现按冻结 profile 路由后，两个本地受控 HTTP provider 分别收到各自资源 DELETE／GET，只有新鲜 GET 404 认 absent。不是 Docker 实测。
3. A 新配置按钮不存在，真实 Chromium 测试超时；接入真实 API 面板后，发布响应丢失、刷新、原命令回放和普通 Run 选择通过。
4. 同 provider 的第二镜像获准期限 20 秒，提交 21 秒预览本应拒绝却返回 200；改为按镜像允许集限制后正确返回 400。随后独立模型修订实际到达 SandboxPort、运行中停用仍成功且清单摘要不变通过。
5. 旧镜像／模型退出执行模板时原 provider 回收原本被错误拒绝；收窄回收授权到原 mode／provider_ref／endpoint 后，旧资源仍由原 HTTP provider 删除并查询确认。
6. 04 形态数据库移除 05 表后，用新默认重启时旧历史缺失导致断言失败；从旧 Run 冻结依据迁移后，新旧历史与原 provider 回收、旧 key 原 Run、原 manifest digest 全部通过。
7. 连接变更预览最初只有 hash，缺失 endpoint 字段差异；增加持久语义快照后，前后 endpoint、credential identity 可审阅，不暴露 secret_ref。

另外覆盖：同 generation 并发只一条提交；同 key 同内容原回执、改内容冲突；停用拒绝新接纳但旧 key 重放先行；审计写入注入失败回滚配置与回执，恢复后原 key 可提交；拒绝任意 secret/env/endpoint/挂载/脚本和虚构兼容性。维护者权限与工作区隔离在服务端执行；另一浏览器标签切换会话时原 actor／workspace 期待阻止误发布。

## 执行记录

- [typecheck.txt](typecheck.txt)、[build.txt](build.txt)：类型／构建。
- [full-suite.txt](full-suite.txt)：53 项完整 suite，0 失败／跳过。
- [compiled-restart.txt](compiled-restart.txt)：编译 main 真实独立进程重启、固定新修订、停用、原命令回执、原 Run 和排他锁；只使用临时 fixture 库／随机测试令牌，不打印凭据。
- [browser-suite.txt](browser-suite.txt)：真实 Chromium＋API＋SQLite；测试 fixture 独立库。
- 截图：configuration-preview.png、configuration-mobile.png、run-fixed-revisions.png、selected-mode.png。selected-mode 的 live 目录仅测试提交前展示，浏览器 harness 的 live 执行明确拒绝，无网络／模型调用。

未执行：获准模型真实调用、实际 OpenSandbox 容器／Docker／Linux 隔离、旧 live 凭据映射核验、人工验收。未读取无关凭据、未部署远程、未改依赖图、未关闭综合 AC。
