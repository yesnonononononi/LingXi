# 工作流边界

`workflow` 位于业务模块上方，协调聊天、重发、审批、委派和恢复。HTTP 路径、工具注册名、执行快照结构及业务状态编码保持原有契约。

- `application.chat`：请求准备、受理事务和执行分发。
- `application.approval`：人工决策、命令执行、结果回填和卡片开放时机。
- `application.resume`：恢复意图调度、重试和挂起代际检查。
- `application.projection`：把已提交的框架事实转换为轮次、会话用量与实时视图更新。
- `infrastructure.harness`：Agent、检查点、历史接收器和注册表适配。
- `infrastructure.lifecycle`：进程内运行资格、执行门闩、子执行收尾与启动清理。
- `infrastructure.listener`：按业务职责分别接收框架事件，保留各自顺序及异常策略。
- `infrastructure.stream`、`infrastructure.config`：SSE 连接与框架快照 JSON 装配。
- `infrastructure.tools`、`infrastructure.policy`：工具执行器与框架执行策略。

业务模块禁止依赖 `workflow`。需要运行时事实时，由业务模块在 `application.port` 定义接口，工作流提供实现。执行锁、卡片可用性和工具目录均按此方式接入。

领域规则、状态变更、PO、Mapper 和 DDD 仓储保留在原模块。工作流通过应用服务或领域仓储调用业务能力，不直接引用业务基础设施。已有消息、配置及用量值类型的转换仍由所属模块负责。

工具目录接口归 tools 模块，设置读取与策略值类型归 user_configs 模块。框架 Execution 和 ExecutionState 的读取、转换及控制均留在工作流，业务检查点服务只接收身份、状态码、快照和时间。

聊天受理必须先拿到真实会话和运行资格，在同一事务内写轮次、用户消息与完整执行快照，提交后执行同一个框架对象。模型调用和命令副作用不放进受理事务。

检查点提交和旧控制信号释放后，才能开放卡片、推进等待或收口终态。恢复必须保持 `SUSPENDED`、未决槽位和代际守卫；迁移不能产生第二组执行锁，也不能把生命周期通知提前到提交之前。

`WorkflowDependencyTest` 递归检查依赖方向，并以嵌套目录、零字节及故意违规引用验证扫描覆盖。
