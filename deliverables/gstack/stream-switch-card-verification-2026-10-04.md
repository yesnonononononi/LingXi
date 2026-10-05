# 流式渲染、切会话与卡片恢复核验

日期：2026-10-04。结论：未完全解决，4B 不能完成验收。

本轮只核验并新增审查用例，未修改生产实现。原门禁 92 + 4 条通过，`npm run build` 通过；后端定向回归 20 条通过。新增生产组合函数与 SSE 接线核验 7 条：2 通过、5 失败。

## 核验方式与边界

`frontend/tests/streamV3SwitchAudit.test.ts` 调用实际 `useChatView`、sseRouter、readSseResponse、streamV3Sync、streamV3Store 和 messageProjection。替换 HTTP 出口，显式推进 SSE 与命令回执；自动重连用例显式执行登记的退避回调，不等待随机时长。每例以 effectScope 收拢 watch，并在结束后停止作用域、关闭连接和恢复被替换的方法。

这是 Node 跨模块核验，没有真实浏览器 DOM、Electron 或真实运行中的后端。后端另以 H2/Mockito 定向回归验证卡片开放与提交投递。用例暴露的是生产状态与派生视图缺陷，不应称为浏览器端到端验收。

## 可执行结果

| 场景 | 结果 | 实测 |
|---|---|---|
| 正常 A→B→A，恢复持久化正文并接收同轮次增量 | 通过 | 已提交正文恢复，切回后的增量可见 |
| 新轮次只有用户落库行，随后 RESPONSE_STARTED/TEXT_DELTA | 失败 | 响应槽已有正文，用户行已显示，但回答正文不可见 |
| A 发送命令期间切到 B，A 回执迟到 | 失败 | 当前查看仍是 B，但 B 的 SSE 已被关闭 |
| HISTORY_INVALIDATED 与新代际提交先到，重发回执后到 | 失败 | 新回答已显示；旧轮次清理回执到达后，新回答消失 |
| 切走期间卡片已决断，切回时快照包含已决断历史卡片 | 失败 | 未决集合为空，历史载荷为已批准 v2，旧工具槽仍让卡片显示待审批 v1 |
| 服务端断流，执行自动重连回调，新连接 READY 到达 | 失败 | 已建立第二条连接，但 bootstrap 请求数仍为 1，未重建同步 |
| 卡片先于宿主到达，随后收到已决断版本更新 | 通过 | 计划正文可见，始终一张卡，决断后 pending=false |

## 五项缺陷与修复边界

### 1. 新轮次缺少流式回答宿主（P0）

`messageProjection.ts:166` 只把响应叠加到已经存在的同 turnId assistant 气泡。USER 行不会创建该气泡，RESPONSE_STARTED 也只创建响应槽；找不到宿主时直接返回基底。因而只有用户行的正常新轮次，文本已收到也不显示，直到 AI 落库才可能出现。

应由活响应为尚无 assistant 宿主的轮次派生稳定回答气泡，沿用已确定的会话与轮次身份；落库后归并到同一展示身份。不要另建可变消息表。

### 2. 自动重连未重新同步（P0）

`streamV3Sync.ts:62` 的 bootstrapSent 是旧协调器闭包的状态。自动重连复用订阅者，没有触发重新订阅的 onReattached；新的 READY 虽被接受，runBootstrap 却因旧 bootstrapSent=true 返回。新连接没有新的快照与暂存屏障，阶段停在 bootstrapping。

应按连接身份建立新的同步代次，重置该连接的 bootstrap 状态，并作废上一连接在途请求。相同连接重复 READY 与真正的新连接 READY 要区分。

### 3. 迟到命令回执夺走当前会话连接（P1）

`useChatView.ts:1360` 在 A 回执到达后无条件补挂 A；attachSessionStream 随之退订并关闭当前 B。B 的活跃 id 没有变化，watch 不会再补挂，形成「看 B、听 A」。

应在发起请求时固定操作归属。迟到回执可更新 A 的实体事实，但不能切换 B 的展示连接；连接选择由当前查看会话决定。

### 4. 重发回执抹掉新代际事实（P1）

`useChatView.ts:1369` 收到 invalidatedTurnIds 后调用 resetSession(owningSessionId)。它清空整会话的响应与历史，而非只清回执指明的旧轮次。两个通道没有顺序保证；新代际提交若先到，就被迟到回执清掉。

应让回执与失效事件收敛到幂等的作废处理，只作用于旧代际或被作废的轮次/执行，保留已经到达的新代际事实。不能用切会话的 resetSession 替代重发作废。

### 5. 切回后旧待审批卡覆盖权威历史（P1）

resetSession 保留 tools；bootstrap 只按版本写入返回的工具实体，没有清理不再属于未决集合的旧 pending 槽。后端 bootstrap.toolCalls 是完整的未决卡片集合，已决断卡不会返回。即使历史 TOOL 行带已批准的新版本，applyCards 仍把历史卡摘掉，再按旧 tools 槽挂回待审批卡。

应按快照明确的会话树与未决集合范围对账，或将历史权威工具事实按版本并入唯一工具槽。不能把「快照范围外保留」理解为「完整未决集合中已消失的卡永远保留」。其他根会话的卡不受此次对账影响。

## 运行方法

在 `D:\Code\LingXi\frontend`：

```powershell
npx.cmd tsx --test tests/streamV3SwitchAudit.test.ts
```

当前应得到 7 条、2 通过、5 失败。审查文件未加入默认 npm test，避免把原门禁的通过数量与新增反例混为一谈；修复时可逐条纳入正式回归。

后端定向回归，在项目根目录：

```powershell
mvn.cmd -o '-Dtest=ToolCallReadinessTest,CommittedStateV3DeliveryTest,EventStreamPublisherTest' test
```

结果：20 条、0 失败、0 错误。它支持挂起/旧信号释放后开放卡片以及根身份投递的已有保护，不证明真实界面审批全链路已完成。

建议先修新轮次宿主与自动重连，再修回执归属、重发幂等作废和未决卡片快照对账。上述修复均不需要高频查库或新增后端缓存。
