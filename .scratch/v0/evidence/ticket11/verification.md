# Ticket11 验证账本

日期2026-09-14；完整票已实现，停在人工 smoke／实际体验。用户未确认验收，AC未勾选。最终产品提交91621998077e53d2f6ffb7dfd9789e9d0f6d146e；文档和证据另提交，不改写 checkpoint。详细行为见 [实现说明](../../../../docs/implementation/ticket11.md)。

## 分层证据

| 层 | 输入、动作 | 结果与出处 |
|---|---|---|
| 最终构建／单测 | Node24.18.0，npm run build；npm test | [构建](build-final.txt)通过；[139/139](unit-final.txt)。包括并发2、降低并发、unknown仍占位、无Attempt排队到期、旧清单冻结、setup新默认3600秒、输入／产物限额、金额拒绝、own-key、授权、同命令重启恢复和真实SQLite审计故障回滚。 |
| 真实SDK受控HTTP | 持续SSE、分行memory.events、晚到资源文件、观测回调抛错 | 包含于139项，adapter12/12；确认后原资源DELETE仍发生，SDK流退出，budget/memory_mib，不把SDK abort当停止证据。 |
| 独立guardian | Linux Python＋真实SQLite＋受控Docker API故障 | [3/3](guardian-final.txt)：前项连续三次删除失败不饿死后项；重启同ID恢复；空到期intent仍处理晚创建；Docker失败不能被observer记absent，健康过期unknown。 |
| A 浏览器 | 真实页面、HTTP/API、SQLite，明确FixtureSandbox | [19/19](browser-final.txt)，最终[desktop](limits-desktop.png)、[mobile](limits-mobile.png)目视，范围逐项可读且无横向溢出。丢失发布回执、刷新恢复、任务冻结限额；历史05–10截图已恢复。浏览器文件对应最终web源码（修复后未再修改web）。 |
| 真实执行层 | 固定SDK/CLI→合成HTTPS模型协议；cgroup、tmpfs、provider、guardian | 最终五Run如下。执行镜像36核心JS与9162199构建逐一[相同](build-comparison.json)；[镜像hash](image-build-sha256.txt)。 |
| 双轴审查 | 固定基线、两个fresh只读agent并行 | [Standards原2项、Spec原1项全部关闭](review.md)，无新确定问题；reviewer没有替实现代理重跑测试。 |
| 真实模型／gVisor／人工／生产容量 | 未有获准模型配置；Docker runc；用户尚未确认 | **未验收**。协议receiver没有模型推理、语义判断或真实计费。宿主总RAM3723MiB不能证明2×4GiB生产容量。 |

最终 unit 139/139 和build均执行于9162199相同代码树；后续只去掉Python测试文件句柄警告、文档和证据整理，Linux测试3/3再跑。浏览器最终19/19运行时后续改动只涉及resource/guardian及harness，web内容未变。失败的初始全套和压力组不计入上述PASS。

## 最终真实五 Run

最终 runtime `sha256:ce8d0083a606a9a45b8667e60ccd442681056be1e6c6c0993249d66aa022aac4`；server `sha256:7c3decc295f65c5b1224d8fc4e8fbaf4a06b3b4710d62247e8238b4fd9d14f14`。每次只有一个任务sandbox进行物理实验。default展示2CPU/4GiB上限，其他使用批准的0.25CPU/384MiB低资源压力，不将其当默认满载容量验收。

| 场景与Run | 输入／动作 | 可观察结果 |
|---|---|---|
| 默认 fa366aa4-74d9-40d4-a4ec-44c25cbb06b8 | Return approved JSON；真实固定CLI，受控协议 | succeeded；cgroup CPU200000/100000、memory4294967296，tmpfs参数190840832；独立资源确认删除。[Run](physical/normal/default-result.json) |
| 产物 fdb385ed-0afa-48a2-a542-b0d69a17bebe | 合法CSV，真实固定Bash处理程序；artifact_bytes=1 | budget_exceeded/artifact_bytes；无Result，stop stopped／cleanup complete。[Run](physical/normal/artifact-result.json) |
| 总期限17e546e7-fce9-474f-b5ab-77b5a40eb307 | provider最小lease60秒，但Run总期限15秒；协议receiver保持请求 | deadline03:17:12.768Z，业务timed_out03:17:12.769Z；stopped／complete。原请求到Result边界没有延长。[Run](physical/normal/deadline-result.json) |
| 压力 aecf992c-d3f0-4be1-8a6b-19b30b33a139 | 实际CLI持有协议请求；host向同一原容器注入受控CPU、流式写文件、内存分配 | CPU nr_throttled94→136；tmpfs190840832bytes后ENOSPC；memory max0→1076、oom0→7、oom_kill0→1；budget_exceeded/memory_mib，stopped／complete。[host](physical/pressure-host.jsonl)、[Run](physical/pressure/memory-result.json) |
| 全控制面故障ef2e69d8-55ce-4ce3-8af1-2b3ec24a3782 | KILL原API＋worker driver及原provider；guardian保持独立 | 原deadline03:13:29.828Z；main/sidecar03:13:30.517Z明确不存在。之后恢复原driver＋DB，仍同Attempt fc897d46-06f3-453e-ae3f-5b49c19c3118、deadline_exceeded，accepted1/replayed1、attempt.start-intent1。[host](physical/crash-host.jsonl)、[恢复](physical/crash/crash-result.json)、[审计投影](physical/resource-ledger.json) |

压力是经授权的 host 注入，**不是**模型自主产生压力动作；真实CLI确实启动，注入开始前读取其受保护model started记录。CPU节流和内存终止分开；exit137只是进程退出，三项cgroup增量才用于预算归因。Docker MemorySwap实际805306368，RAM402653184；前者不是另一个被误记成RAM的额度。真实SDK样本 `segments=["low 0","high 0","max 0","oom 0","oom_kill 0","oom_group_kill 0"]` 保存于host日志，回归测试使用相同分段形状。

crash停止时API/worker原ID `e050c6b1eafb4985b4d49027019e9340846040e48830475da525754606228a1e`，provider `d64624271a8ca6abac81b917fc1d0c4b6dbf9a3f60d815f75242fc9cc4da8378`。guardian `dea32264f90ec3e721d0ce715954025ac6a3c5d1ff605d1c6669141d463f3bda` 独立存在，随后重启同服务从SQLite恢复16个原intent，unknown0/resources0/volumes0且fresh。业务终态时间是控制面恢复后的03:14:44.721Z，不能拿这个时间代替03:13:30的独立物理删除观测。已准入模型收尾unknown，不伪造推理结果。

## 版本、复现与清理

Linux Ubuntu24.04、Docker29.1.3/runc；Node24.18.0、Claude Agent SDK0.3.270/bundledCLI2.1.270、OpenSandbox SDK0.1.11。server基于固定上游d8cfce39dc1d846e580510ca44f44c495cbe95c4及Ticket10 isolation patch，再追加limits patch把原Run/operation/guardian标签同样写到sidecar；不换原版server，不把Docker当gVisor。

在获准Linux节点，将9162199的dist/deploy/scripts准备到`/tmp/atomicagent-ticket11-work`，可使用仓库的 Dockerfile.runner-update 与 Dockerfile.opensandbox-update，分别基于保留的10镜像 `sha256:f26adbee7fb83c4f8ee6f008793dde0c96de93591c30e210832a1aa4876a008a`、`sha256:0f5fa5a6f63e55c973a81767de0fe19fdc061a69cdd469666f050582073c8bc6` 构建两个11标签。依赖引擎未重装；执行镜像只承载runner和实验driver，不作为Web发布包。全量从源构建另有Dockerfile.opensandbox，需依赖下载可用。

```bash
cd /tmp/atomicagent-ticket11-work
bash scripts/start-limits-experiment.sh
image=$(docker image inspect atomicagent-ticket11-runtime --format '{{.Id}}')
python3 scripts/observe-limits-experiment.py "$image" pressure
# 压力完成并确认原资源不存在后，才做crash；它会停止自有provider服务
python3 scripts/observe-limits-experiment.py "$image" crash
```

start脚本先检查全部43810/43811/43820–43920端口与bridge gateway，再创建命名并标记的自有服务／网络和合成证书。server仅127.0.0.1监听，execd/egress发布端口全部loopback；任务无Docker socket，guardian/server持socket是可信控制层。normal driver详见scripts/verify-provider-limits.ts；正常main的人工入口见实现说明，不能把实验故障开关放进产品UI。复现实验需新的records和服务生命周期；旧结果先归档，不复用已终态业务key发起第二执行。清理脚本内历史IDs仅用于复核本轮，重现时必须根据该轮创建记录改成新原IDs，不能按同名服务盲删。

[resource-ledger.json](physical/resource-ledger.json)共16个Run（包括失败与中间版本），30登记Docker IDs、11运行卷全部新鲜明确absent；同identity的unknown业务记录没有被手改。2026-09-14T03:21:36Z [cleanup.jsonl](cleanup.jsonl)确认本轮七个自有容器、两个失败builder、原network、远端两个工作目录／三个归档和合成证书全部清除；全部实验端口清空，原五Relaticle服务healthy。available RAM2462MiB，磁盘25GiB。保留两个最终11镜像、原10镜像及共享构建层；未执行prune、未改全局daemon/firewall或宿主swap。

本机三个临时tgz、normal-temp复制目录和deploy/__pycache__因自动审批拒绝删除而保留，不进入git。原4310进程保持；root另行保留的4312正常main用于用户人工验收，属于交付服务，不是漏清理的实验资源。

第一方语义核对：[Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)解释CPU节流、内存和swap；[Linux cgroup v2 memory.events](https://cdn.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)区分max、oom、oom_kill。来源由root核对，本票实际观察数值仍以原日志为准，不从文档推定压力PASS。
