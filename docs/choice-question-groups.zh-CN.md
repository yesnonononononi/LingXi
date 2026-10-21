# 同组选择问题

模型可在同一次响应中多次调用 `require_choice`，每次调用仍只包含一个问题。框架收集全部工具结果后统一挂起；业务侧按原响应的 `responseId` 分组，不新增框架状态或数据表。

前端以标签和上一题、下一题切换问题，草稿按 `toolCallId` 保存。全部卡片准备完整、全部待答问题填写后才允许统一提交。提交期间禁用修改和重复提交；未修改答案的网络重试沿用同一 `commandId`。未提交的草稿仅保存在当前页面，已提交答案从权威卡片回显。

## 批量接口

`POST /tool-call/choice-answers` 接收：

```json
{
  "conversationId": "500",
  "responseId": "2105000000000000011",
  "commandId": "choice-unique-command",
  "answers": [
    {"toolCallId": "call-a", "expectedVersion": "2", "text": "答案 A"},
    {"toolCallId": "call-b", "expectedVersion": "2", "text": "答案 B"}
  ]
}
```

服务端从已落库的原模型响应核对该组成员，要求提交全部待答问题。会话、执行、卡片状态、版本、原工具结果槽位必须全部匹配；按调用 ID 精确回填，不按同名工具猜测。

全部卡片结论、模型上下文和执行检查点在一个事务内写入。任意一步失败整批回滚；全部写入后只登记一次恢复请求。执行还有其他未决工具时，回执仍为 `WAITING_OTHER_TOOLS`。

同一命令的成员、版本和答案共同构成摘要。相同请求重试返回已保存结果；同命令改答案、删减成员或改变版本会被拒绝。

成功返回 `Result<ChoiceAnswersReceipt>`，其中包含 `commandId`、`decisionApplied`、本次全部 `toolCalls` 和 `resumeDisposition`。前端据此更新卡片，不能因请求已发出而自行标记已回答。

## 验证

- `mvn -o test -Dtest=ChoiceAnswersServiceTest,VersionedToolCallDecisionTest`
- `cd frontend` 后运行 `npm test`、`npm run build`。
- `npm run test:choice-groups:ui` 验证真实 Vue 组件，并在 `node_modules/.tmp/choice-question-group/` 输出浅色、深色和窄屏截图。
