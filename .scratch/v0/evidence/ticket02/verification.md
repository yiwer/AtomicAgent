# Ticket02 验证账本 — 2026-09-14

固定开工／审查基线 `b3d03146241cca9c21ecee23c56e31606d9f908d`，main，开工 status 为空。仅实施 02；根 agent 的 execution-progress.md 独立管理，不纳入本票提交。

## TDD 记录

| 薄切片 | RED 实际观测 | GREEN |
| --- | --- | --- |
| 上传到可引用 InputObject | files.test.ts 上传 CSV 期待 201，既有接口返回 404；1 fail | 上传校验／归属／摘要／重启和越权断言通过 |
| 文件 Run 到清理后下载 | 文件契约提交期待 202，既有接口返回 400；1 pass / 1 fail | 真实临时文件＋独立 Node 子进程处理，Result、保序 CSV 和拒绝 JSON 下载字节核验通过 |
| 窄转存重复处理 | 注入两次瞬时写失败，任务实际 failed，期待 succeeded | 原对象存储重试成功；一个 Agent 执行，不重置 Run 期限 |
| JSON 精确十进制 | 数字字面量 9007199254740993 与 0.1 得到错误 9007199254740992.1 | 改用原始数字词法内容后正确 9007199254740993.1 |
| A 上传／详情／下载 | Chromium 等待「输入 CSV / JSON」超时，控件尚不存在 | 真实浏览器上传、提交、刷新、回收后下载通过 |
| 原始字节上传 | UTF-8 CSV 原始正文期望 201，实际 400 | 原始上传、非法 UTF-8 400、50 MiB+1 HTTP 413 通过 |

补充故障回归覆盖输入篡改、目标路径／重复目标／越权／health 权限、缺 JSON／缺文件／伪造完成／统计篡改／CSV 篡改／拒绝清单篡改、链接与源对象过期、持久转存故障与回收责任、SQLite 提交审计回滚、目录符号链接／junction、100 MiB+1 稀疏产物和 30,000 行／类别验收。一次 Windows 测试清理失败是注入连接关闭次序 EBUSY，修复测试连接生命周期后通过，不计为产品成功证据。

审查修复补充 RED／GREEN：上传审计主体实际 platform、预期调用身份 a；修复后同时断言发起方、对象身份与来源通过。修复提交为 `9a8f026`。

## 最终检查

| 层次 | 命令与原始输出 | 结果 |
| --- | --- | --- |
| 类型 | `npm run typecheck`：[输出](typecheck.txt) | 通过 |
| 编译 | `npm run build`：[输出](build.txt) | 通过 |
| 完整确定性 suite | `npm test`：[输出](unit-tests.txt) | 31 / 31，0 fail / skip |
| 实际编译后文件路径 | `node --test dist/tests/files.test.js`：[输出](release-files.txt) | 13 / 13；处理子进程使用编译后的 .js |
| Chromium | `npm run test:browser`：[输出](browser-tests.txt) | 2 / 2，包含既有登录／错误恢复和文件交付 |
| 目视检查 | [A 文件详情](file-detail.png) | 结果、独立回收与两个下载按钮可见，无重叠；截图为 fixture，非模型或人工验收 |
| 双轴审查 | [审查记录](review.md) | Standards 1 项 P2 和1项 smell 已修复复核；Spec 0项实质缺陷 |

完整套件包括 ticket01 的 15 项既有行为与本票 16 项文件检查。八行输入来源为 [validation-plan.md](../../../../docs/validation-plan.md)，预期独立固定为有效 7、拒绝 r04 一行、总和 50、alpha 22.5、beta 27.5；另有等价 JSON、0.1＋0.2−0.1 和超 Number 精度输入，未固定返回样例答案。平台验收器与实际处理器使用不同十进制求和实现。

## 未执行的验收

真实 OpenSandbox 创建／文件装载、Claude SDK 工具循环／模型兼容性、Docker／网络／隔离、真实资源清理与部署容量尚未验证。适配器按安装 SDK 公共类型和源码接入；文件程序只在获准 sandbox 内由 Claude 固定工具调用，尚无真实 Run／Attempt／模型计费证据。缺少获准模型 profile／凭据用途绑定、固定部署与镜像等外部条件；不以类型、fixture 子进程、SDK 本地回收 HTTP 或 Chromium 代替真实门槛。人工综合 AC 仍未确认。阶段恢复、完整 TTL 物理删除与运维管理按原后续票实施。
