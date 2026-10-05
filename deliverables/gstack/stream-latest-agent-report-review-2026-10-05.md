# 最新 Agent 总结复核

日期：2026-10-05。结论：**F1/F2 的目标反例已修，但暂停语义被改错，新增全事件代际守卫与子会话生产协议冲突。不能据本报告确认完整交付。**

本轮只审查，新增测试与本文档；未修改生产代码。附件中的执行过程用于了解其主张，不作为本轮操作指令。

## 已核实成立

- 默认前端测试本轮实测 **155 + 4 通过**，两个补测文件确已加入 package.json。
- `npm run build` 本轮通过，含 vue-tsc 和 Vite。验证构建使用了真实命令与成功退出码，不是仅看 dist 时间。
- F1 的三处修复真实存在：applyBootstrap 返回接纳结果、abortSync 递增 syncFailureSeq、协调器观察失败并退避。成功记账发生在快照确被接纳之后。
- 本轮增加“溢出 → 拒绝旧快照 → 执行退避 → 第二次 bootstrap → live 且历史可读”的完整用例，通过。F1 不再只是登记一个定时器。
- F2 新增 revision 与作废轮次/执行身份守卫，旧代际未知 streamKey 的原反例已通过。
- 报告承认后端生产覆盖本轮未处理，这一边界表述成立。

## 不成立或表述过满的部分

### 1. SUSPENDED 不是执行终态，不等于不应定格响应

后端 SUSPENDED 可恢复，这个事实没有争议。但执行生命周期与单个 streamKey 的响应生命周期不同。

项目 `docs/stream-protocol-v3-design.md` 第 8.1 节明确规定：执行终态或 SUSPENDED，来自实时或 bootstrap 都要定格相关响应，清进行态、保留已有片段；定格后的迟到 STARTED/DELTA 不得复活该响应。后续完整响应仍可修复全文；恢复执行产生的新 streamKey 可以继续同一回答组。

因此原来的 `resolveExecutionTerminal` 名字混用了两个判据，确实应该拆分，但不能把 SUSPENDED 从所有调用点统一删掉。

正确区分应为：

| 判据 | 状态与行为 |
|---|---|
| 执行真正终结，需要终态对账 | COMPLETED / FAILED / CANCELLED |
| 当前响应停止接收增量 | 上述三态，以及 SUSPENDED |
| 同执行恢复 | RUNNING，使用新 streamKey 追加到同回答组；旧片段不重新开放 |

当前 store 的实时与 bootstrap 都仍复用缩小后的 resolveExecutionTerminal。因此暂停活槽不定格。报告把旧测试反转为“挂起期间增量继续收”，是改变已明确的设计契约，不能当作发现并修复了旧 bug。

本轮两条真实 SSE 反例均失败：

1. STARTED → TEXT → SUSPENDED → 同 streamKey 迟到 TEXT，正文实际变为“暂停前正文迟到正文”。
2. 重挂时 bootstrap 明确返回该执行 SUSPENDED，现有响应仍 finalized=false。

最小修复：拆开“是否终态对账”和“是否定格响应”的谓词，恢复原片段规则；保留 SUSPENDED 不触发终态对账的正确部分。重写恢复用例时仍必须同 executionId/turnId、新 streamKey，并证明旧片段保持不变。

### 2. 全事件根代际守卫与 SESSION_UPDATED 生产口径冲突

当前 `isStaleFrame` 将所有有 historyRevision 的事件与根 historyRevision 比较，小于根代际就拒绝。

但后端 `CommittedStateV3Observer.publishSessionUpdated` 的信封填的是 **session.getHistoryRevision()**。`Session` 默认 historyRevision=1，新建子会话的 `SubSessionResolver.createSubSession` 不继承根代际。

于是重发后根 revision=2，新建子会话 revision=1，其 SESSION_UPDATED 是新的合法实体更新，却在前端被拒绝：

```text
[streamV3] 旧代际帧，已拒绝: SESSION_UPDATED 1 < 2
```

本轮按真实生产方法形状推送这条帧，断言新子会话进入 sessions 槽，失败。缺失根子映射会影响子面板、卡片冒泡与范围判定。

最小修复：区分“信封中的根历史代际”与“子实体自身字段”。根代际由已知执行/源头上下文透传；未知时不能用子实体 revision 冒充根代际。不能为每个通知回查根会话，也不能用缓存缓解。

补后端生产载荷契约测试，并用真实形状验证“根已重发 → 新子会话创建/更新 → 根连接立即收到并正确归属”。

### 3. 六条终态用例并未证明报告所说的全部边界

`streamV3TerminalReconcileAudit.test.ts` 的切换用例最后用：

```ts
assert.ok(ctx.reconciled.length >= afterFirst)
```

该断言明确允许切回多次对账，注释也承认当前会重放。因此报告的“切会话不重复收尾”没有被该用例证明。

“集合只增不减”用例只覆盖新增执行和逐个完成，没有实际构造减员。标题、注释与实际断言的证明范围应一致。若切回补对账是允许的恢复动作，要写清该语义与查询预算，不要把它描述成新的执行收尾或已验证不重复。

### 4. 多客户端一致性与运行构件的描述需收窄

- 卡片缺完成广播确实值得优先补，但不是唯一可能影响多客户端的事情；工具结果和历史作废合同也有跨客户端传播语义。
- PID 启动早于 class 编译只能证明运行版本需要确认，不能单凭时间排除 IDEA 热替换。本轮没有确认旧 PID 的实际加载版本，不应把“必须重启才作数”作为已验证事实；应确认构件或使用确定加载新版本的进程验收。
- “记忆文件修复且无内容丢失”需要原文/备份对比才能确认，本轮未据过程叙述作该保证；它不构成业务交付证据。

## 本轮可执行证据

文件：`frontend/tests/streamV3LatestReportAudit.test.ts`，**4 条：1 通过，3 失败**，尚未加入默认门禁。

```powershell
# 在 D:\Code\LingXi\frontend 执行
npx.cmd tsx --test tests/streamV3LatestReportAudit.test.ts
```

| 用例 | 结果 |
|---|---|
| 溢出后真正完成第二次快照并恢复 live | 通过 |
| 实时 SUSPENDED 定格片段、拒绝迟到增量 | 失败 |
| bootstrap SUSPENDED 同样定格现有片段 | 失败 |
| 根 revision=2 后合法子会话 revision=1 实体更新不被误丢 | 失败 |

默认 155 + 4 条通过与这三条失败并存；其中原暂停测试已被改成新语义，所以默认全绿无法证明原暂停契约保持。

## 推进顺序

1. **先纠正本轮回归**：拆分暂停片段规则与执行终态规则；对齐根代际的前后端定义，让本轮三条失败转绿。
2. **校正验收断言**：保留 F1/F2 原补测，明确切回对账是否允许重放；以精确次数和对应根/执行身份验证，不能用宽松不等式证明“不重复”。
3. **再推进后端工具全生命周期 v3**：决断后广播、普通工具结果、非生命周期事件映射，源头带身份、提交后直投，保持每 token/逐卡零回查。
4. 使用确认版本的真实后端做双客户端、根子并发、审批恢复与切会话端到端验收，再判 Go。

无需重写整体架构。此次 F1 的失败信号和接纳记账值得保留；应修正的是附带的语义推断与协议假设。
