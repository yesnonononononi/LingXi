# 流式对话展示契约设计

设计日期：2026-10-06。本文是前后端设计稿，配套 stream-render-contract.ts 是可独立检查的契约，不代表功能已经实现。

**1. 设计决定**

后端维护可直接展示的视图，SSE 同步视图变化，历史查询读取同一份视图。前端保存实体字典和后端提供的子节点列表，按 ID 覆盖实体、按列表渲染。模型调用轮次、原始事件排序、正文归类、执行身份映射全部留在后端。

这里用更完整的后端投影、持久化和订阅设计，换取前端代码简单、实时与历史一致。VO 本身不能修复事件来源缺失、数据库提交失败或失序发送；这些是实现本契约必须满足的后端条件。

对外只有两个事件：VIEW_RESET 提供完整视图，VIEW_PATCH 提供发生变化的完整实体。没有 TEXT_DELTA、TOOL_COMPLETED 或 EXECUTION_* 等框架事件，前端也不根据它们推进状态。

前端没有 execution_id、模型轮次计数、order、seq、业务时间线或重排缓存。时间戳只用于展示。订阅连接有一个不透明的 subscription_id，用于拒绝已关闭连接的回调，不参与排序或业务推断。

**2. 视图层级与身份**

~~~text
ChatRenderViewVO
  directory.session_ids
    Session.turn_ids
      Turn.bubble_ids
        Bubble.block_ids
          Block
            Text / Reasoning → segment_ids → TextSegment.text
            Tool             → 已装配的卡片内容与状态
            Notice           → 明确的提示内容
~~~

所有列表都是后端已经确定的展示顺序。前端只按数组遍历，不读取 ID 大小，不按时间戳排序，不从 Map 的遍历顺序猜位置。

| 身份 | 含义 | 稳定范围 |
|---|---|---|
| session_id | 内容属于哪个会话 | 实时、历史、重连一致 |
| turn_id | 内容属于哪次业务请求 | 挂起、恢复不改变；重发创建新轮次 |
| bubble_id | 哪个视觉气泡 | 创建到终结不改变 |
| block_id | 哪一段文本、思考或工具卡片 | 流式与历史一致；内容校正不换 ID |
| segment_id | 文本传输分片 | 当前文本版本内稳定，不是消息身份 |
| subscription_id | 哪一条展示订阅 | 每次建立新连接都会变化 |

默认每个已受理的 turn 有一个已关闭的用户气泡、一个开放的助手气泡。助手气泡包含多段独立文本和工具块，能够表达样本中的持续过程说明与最终回答。协议允许同一 turn 有多个助手气泡，bubble_id 不与 turn_id 混为一谈。

ID 全部按字符串传输。JSON 字段采用 snake_case；Java 字段采用 camelCase，在本模块 DTO 上配置命名策略，不修改项目全局序列化规则。

气泡中的块按后端给定顺序直接显示。过程说明和最终回答都走 Markdown，思考块单独可折叠，工具块显示卡片。最终回答的 purpose=ANSWER 只改变语义、复制范围等，不把原文本从一个集合搬到另一个集合。

**3. 为什么采用完整实体覆盖**

原始增量要求前端区分追加、快照、重复事件和完成校正。这里由后端先吸收原始增量，再推送新的展示实体。前端统一使用 dictionary[id] = entity，不深合并，不把 null 当作未提供。

VIEW_PATCH.upsert 中的每个对象都是完整对象。缺失字段属于契约错误。数组为空表示该批没有该类实体；remove 列表执行明确删除。directory=null 表示目录未变；非 null 表示完整替换目录。

同一批内先准备全部 upsert 和目录变化，再应用 remove，校验最终引用关系，最后一次性提交。创建节点、添加父引用以及关闭气泡可以在同一个批次内原子出现，界面不会渲染中间状态。

同一批不能同时 upsert 和 remove 同一个实体。合法批次提交后，目录、父子引用、归属和复制目标必须完整；缺失引用时停止应用并重连取快照，不能创建猜测占位或回落到最后一个气泡。

**4. 文本分片让覆盖更新保持轻量**

文本仍然属于一个 TextBlock。TextSegment 只是传输与保存单元，不生成气泡，也不生成单独的 Markdown 组件。

后端将原始 delta 累积到尾片，建议每片最多 4 KiB UTF-8、按完整 Unicode 字符切分，约 50 ms 合并一次更新。尾片增长时只推送尾片的完整新值；前端不执行 content += delta。

~~~text
初始：block.segment_ids = [s1]；s1.text = "正在"
更新：只发送 s1.text = "正在检查"
封片：s1 不再变化
新片：发送 s2，并覆盖 block.segment_ids = [s1, s2]
渲染：segments[s1].text + segments[s2].text
~~~

尾片更新最多传约 4 KiB，避免每个 token 重传整个长回答的平方级正文流量。新片创建时才需要更新 segment_ids；各 ID 数组也必须设置产品级容量限制，不能宣称任意长度的单块没有成本。

后台完整响应和累计文本不一致时，保留 block_id，后端生成正确分片引用，在同一批更新 TextBlock、写入新片、删除不再引用的旧片。相同前缀片可复用；分片的复用属于后端优化。

Markdown 始终对一个块拼接后的全文解析。不能分片分别解析，否则代码围栏、表格、链接和跨片 Unicode 内容会损坏。前端仅重新解析内容变化的文本块，可以在一帧内合并刷新。

流的最后一片、模型完成、挂起、取消、失败、气泡关闭前都必须强制 flush。不能让 50 ms 缓冲里的末尾文字落在关闭事件之后。

**5. 各 VO 的职责**

完整类型见 stream-render-contract.ts，其中没有运行时执行身份。

| 对象 | 负责的事实 | 前端不再推断的内容 |
|---|---|---|
| ChatSessionViewVO | 标题、已加载轮次列表、分页游标、上下文用量 | 根子会话路由、未知会话归属 |
| ChatTurnViewVO | 状态、模型、用量、耗时、失败原因、页脚位置、复制目标 | 哪次业务请求结束、该用哪份统计 |
| ChatBubbleVO | 角色、OPEN/CLOSED、块列表、活动提示 | 创建和终结时机、是否正在等工具 |
| TextBlockVO | Markdown/纯文本、用途、生成状态、分片列表 | 当前正文是否为最终回答 |
| ReasoningBlockVO | 独立思考内容与生成状态 | 不能按句子措辞把过程说明归成思考 |
| ToolBlockVO | 卡片类型、标题、结果状态、详情引用、可用动作 | 参数 JSON 解析、工具结果映射与状态猜测 |
| TextSegmentVO | 当前完整片段文本 | 增量去重、字符串追加与截断 |

ToolDetailVO 用可判别联合表示命令、文件、子会话、通用卡片。大输出只推受限预览与 detail_ref，详情接口复用同一装配规则。前端不把任意工具结果 JSON 解析成业务卡片。固定工具名若确实需要分支，仍使用 AgentToolName；MCP 动态工具走通用卡片。

现有 ToolCallVO 含 executionId，不能直接嵌进新契约。必须重新装配 ToolBlockVO，并检查整个嵌套 JSON 都不泄露 execution_id。动作通过后端 action_id 解析与鉴权，前端不能凭 enabled=true 绕过服务端状态校验。

TurnSummaryVO 中未知统计使用 null，真实为零才写 0。失败原因属于 turn，不能伪装成一段助手正文。footer_bubble_id 明确指定页脚，copy_block_ids 明确指定复制文本，不用最后一条消息或文本相等规则查找。

**6. 气泡与内容生命周期**

| 触发 | 后端视图变化 |
|---|---|
| 请求受理成功 | 同事务建立 turn、用户气泡与助手气泡；用户 CLOSED，助手 OPEN |
| 开始模型调用 | 记录后端调用身份，按展示规则建立所需思考/文本块；activity=GENERATING |
| 局部文本或思考 | 更新所属尾片；块保持 STREAMING |
| 一次模型响应完成 | 完整响应校正文本；当前块 COMPLETE；有工具则文本用途为 NARRATION |
| 无工具响应 | 后端记录答案候选；成功结束时确认 ANSWER 和复制目标 |
| 工具开始/完成 | 同一工具 block_id 覆盖状态、预览与动作；不新增结果气泡 |
| 挂起 | turn=WAITING；气泡仍 OPEN；activity=WAITING；停止文本流光标 |
| 恢复 | 原 turn、原气泡继续；新模型调用产生新的文本块；不覆盖首次 started_at |
| 正常完成 | 校正并 flush 文本、确认答案、关闭气泡、发布权威 turn 摘要 |
| 失败/取消 | flush 已知文本，未完成文本标 INTERRUPTED，关闭气泡；保留真实工具状态 |
| 后续统计补齐 | 只覆盖 turn.summary，不重新打开气泡 |

OPEN/CLOSED 表示气泡的生成生命周期；气泡 CLOSED 后允许权威元数据或工具结果的校正，不允许恢复同一个已终结 turn 的文本生成。重试已终结请求要产生新 turn。

工具仍在执行时不能因为父气泡结束就伪造 SUCCEEDED；失败、取消和未知由后端根据实际业务状态决定。子会话拥有自己的 turn 与气泡，根轮次关闭不等于所有子轮次关闭，也不关闭共享根 SSE。

一段文字 COMPLETE、一个工具完成、一个气泡 CLOSED、业务 turn 终结是不同事实。前端只显示这些明确状态，不建立互相推导的布尔条件链。

气泡管理只需要按照 Bubble 的 ID 维护存在性、按 lifecycle 显示生成状态。块渲染器处理内容，不让气泡管理理解模型轮次、工具请求或框架事件。

**7. 后端职责与框架接入**

建议业务模块名为 chatview，避免继续向 AgentEventListener 塞入身份、数据库、卡片和订阅逻辑。

| 协作类 | 职责 |
|---|---|
| RenderIdentityResolver | 解析 session/turn，绑定调用身份与稳定的块 ID |
| ChatRenderLoopInterceptor | 模型调用前分配身份，调用后用完整响应校正并确定工具块 |
| ChatRenderRuntimeListener | 接收局部文本/思考，交给所属调用的文本累积器 |
| ChatRenderProjectionService | 通过领域方法改变展示状态，形成完整实体批次 |
| ToolBlockAssembler | 从权威工具模型装配卡片与动作 |
| ChatTurnViewAssembler | 从 ChatTurn 装配状态、失败原因和统计 |
| ChatRenderSubscriptionHub | 快照屏障、订阅窗口、串行投递与背压 |
| ChatRenderRepository | 保存展示身份、块和分片，供实时与历史共同读取 |

ChatRenderLoopInterceptor 单独注册，order=-900，catchErr=false；取 context.execution()。不改邮箱拦截器，也不抢占框架 Integer.MIN_VALUE。业务扩展失败不能被当作正常投影成功。

onBeforeModelInvoke 把独立调用身份加入运行参数的事件元数据快照。每次调用使用新的身份；不要用“当前 execution 正在写的最后一块”定位异步回调。旧调用迟到的事件由它原本的不可变身份定位并被后端按已关闭状态拒绝。

onAfterModelInvoke 能直接读取响应的 thinking、text 和 toolCalls，避免仅凭 COMPLETE_TEXT 与 TOOL_CALL 的相邻关系猜测正文用途。按响应中工具列表预先建立卡片顺序，工具并行完成只更新原卡片。

COMPLETE_TEXT 可以提供正文校正，但不能关闭 turn。AI_MESSAGE 的完整文本/思考可以补充校正，不能再次新增重复块。重复文字不能按文本内容去重，因为连续的相同字符可能是真实输出。

工具状态应在 toolcall 模块的业务提交之后驱动展示更新，覆盖审批、异步委派回填、等待中取消等非普通运行时事件路径。轮次终结应由业务轮次的持久化状态变化驱动，覆盖启动失败、取消挂起执行和启动收尸，不能只订阅三个框架终态事件。

身份缺失只在后端查询仓储补齐；仍无法确定 turn 的旧数据走显式旧历史适配，不给新实时协议发送空 turn_id，不按当前用户正在看的页面猜归属。

当前 RuntimeEventPublisher 在监听器链外捕获异常，前面的监听器异常可能阻止后面的监听器。LoopInterceptor 的后置回调也可能因先前实现返回非继续而未执行。因此必须保留完整响应校正和业务终态扫尾，不能声称 catchErr=false 能让 RuntimeListener 也可靠。

本设计保证“已提交展示视图”的一致交付。若还要求原始 token 在任何监听异常下都不丢，必须为 StreamingModelResponseHandler 增加可失败、可追踪的接入点或可靠装饰层，并单独验证框架扩展能力；本次设计不假设当前尽力事件已经具备这项保证。框架目录仍只读参考。

**8. 保存与发布必须有一个提交边界**

建议新增展示投影存储，保存气泡和块的稳定身份、父子引用、文本分片及后端来源绑定。它是业务展示投影，ChatTurn、工具领域模型仍分别拥有状态和结果的业务真值。

推荐存储职责如下，落地时按现有数据库能力确定具体列类型：

| 存储 | 内容 |
|---|---|
| chat_render_bubble | bubble_id、turn_id、角色、生命周期、块引用与活动提示 |
| chat_render_block | block_id、bubble_id、类型、展示载荷、后端来源绑定 |
| chat_render_text_segment | segment_id、block_id、完整片段文本 |
| chat_render_root_head | 根会话内部提交位置，用于投影提交串行化与订阅屏障 |
| chat_render_outbox | 已提交的展示变化，供后端有序投递；不作为前端事件回放协议 |

同一个短事务内写投影和 outbox，再由投递器读取已提交变化。不能先推 SSE 再保存，否则用户看到的文字会在重连后消失。原始 delta 先在后端累积，按合并周期写入，不要求每个 token 单独开事务。

已有业务状态事务应同时留下可恢复的展示变更通知；单纯在事务提交后发内存事件仍有崩溃窗口。轮次受理、终态、工具状态变化需要在所属事务内写 outbox 或等价的持久变更记录，投影消费者幂等处理后再生成最终视图批次。来源通知与展示批次可共用 outbox 表，但要区分记录类别。

数据库内部提交位置、实体版本和消费去重只在后端使用，不下发前端。并发消费者必须通过根级串行化或数据库乐观锁/CAS 解决冲突；进程内 synchronized 不能冒充多实例一致性。第一版可单实例，扩容前必须实现根归属与写入隔离。

仓储接口继承 RepositoryTemplate，实现继承 AbstractRepository，使用 PO + BaseMapper + LambdaWrapper。固定锁定查询必要时放 Mapper/XML。领域状态通过领域方法改变；入口校验使用 throwIf；框架源码不改写。新模块优先用 DddCodeGenerator 生成骨架。

历史直接读取已保存的块和分片，不再按原始 AI/TOOL 行重新合并。旧历史可以一次性转换并保存稳定映射；转换未知数据时保留 unknown 信息，不把空 turn_id 猜成邻近 turn。旧数据没有真实业务轮次时，应保留单独的旧历史展示入口，或完成有来源记录的历史轮次迁移后再接入新契约，不能伪造一个执行 ID 充当 turn_id。

**9. 订阅协议承担顺序，前端不重排**

一条根会话订阅承载根与子会话的展示变化。后端为每个订阅单写，发送顺序就是该订阅的视图提交顺序。不要为每条事件启动独立异步发送任务；工具并发不能变成同一连接上的并发无序写入。

建连使用后端屏障：在内部提交位置 C 固定一份不可变视图快照，同时注册 C 之后的变化；先发送 VIEW_RESET，再发送暂存的后续批次。快照与注册必须作为同一个订阅动作协调，不能“先查历史再建流”留下缺口，也不能前端一边收流一边覆盖 HTTP 历史。

连接重建时总是发送新的 VIEW_RESET，取消旧连接并忽略它的回调；不向前端回放原始 delta，不要求 Last-Event-ID，也不让前端计算历史代际。重连快照包含已提交的活动文本分片。

有序通道上的同一完整实体更新重复应用是幂等的。但这不意味着旧批次可以任意乱序重放：旧批次晚于新批次会覆盖新内容，必须由后端内部提交位置拒绝。原始事件不能绕过订阅器直接发给前端。

每个订阅使用有界发送队列。慢客户端超出容量时关闭该订阅，让它重新获取最新快照；不能悄悄丢掉中间结构批次，也不能无限占用内存。发出失败后摘除连接，不改变业务轮次结果。

当前连接出现缺失引用、无效 JSON 或不合法实体时停止应用，并发起一次受控重连。协议版本不支持时显示兼容性错误，避免无限重连。连接 EOF 只表示断线，不表示 turn 完成。

**10. 前端实现范围**

建议用一个 ChatRenderStore 保存六类实体与目录，一个订阅 composable 管理连接，一个 applyViewPatch 实现完整实体替换。types 以契约生成或契约测试对齐，不手写第二套框架事件表。

~~~ts
function applyViewPatch(view: ChatRenderViewVO, patch: ViewPatchVO) {
  for (const value of patch.upsert.sessions) view.sessions[value.session_id] = value;
  for (const value of patch.upsert.turns) view.turns[value.turn_id] = value;
  for (const value of patch.upsert.bubbles) view.bubbles[value.bubble_id] = value;
  for (const value of patch.upsert.blocks) view.blocks[value.block_id] = value;
  for (const value of patch.upsert.segments) view.segments[value.segment_id] = value;
  if (patch.directory !== null) view.directory = patch.directory;
  for (const id of patch.remove.segment_ids) delete view.segments[id];
  for (const id of patch.remove.block_ids) delete view.blocks[id];
  for (const id of patch.remove.bubble_ids) delete view.bubbles[id];
  for (const id of patch.remove.turn_ids) delete view.turns[id];
  for (const id of patch.remove.session_ids) delete view.sessions[id];
}
~~~

上述是通过校验后的机械更新内核。实际入口在临时副本中校验整个批次的引用和归属，再以一次 Pinia patch 提交；不能在更新到一半时因异常留下半棵树。也可以用写集校验避免克隆所有未变实体，不能把每次片段更新变成整个历史视图的深拷贝。

~~~vue
<ChatBubble
  v-for="bubbleId in turn.bubble_ids"
  :key="bubbleId"
  :bubble="view.bubbles[bubbleId]"
/>
<!-- ChatBubble 内部 -->
<RenderBlock
  v-for="blockId in bubble.block_ids"
  :key="blockId"
  :block="view.blocks[blockId]"
/>
~~~

TextBlock 只做 segment_ids.map(id => segments[id].text).join('')，然后传给 MarkdownRenderer。ReasoningBlock 使用同一取文本方法，ToolBlock 按 detail.kind 选择组件。

展开状态、复制反馈、滚动位置保存在独立 UI 状态中，以稳定 bubble_id/block_id 为键。服务器更新数据和重连快照不清空用户主动展开状态；服务器删除节点后才清理对应 UI 状态。

ChatBubble 仅看 lifecycle 和 activity；页脚只按 turn.footer_bubble_id 定位。删除现有 thoughtSteps/aiMessages/toolCalls 三集合重排、liveRound*、文本相等去重、最后一条 assistant 兜底及 token/duration 作为终结证据的判断。

**11. 发送、分页、子会话与重发**

建议将命令受理和展示订阅分离：

| 建议接口 | 返回或行为 |
|---|---|
| POST /a/completion/commands | 接受 command_id 与请求内容，返回 ChatAcceptanceVO |
| GET /a/completion/{rootSessionId}/view-stream | VIEW_RESET 后持续 VIEW_PATCH |
| POST /a/completion/view-subscriptions/{subscriptionId}/history | 接受加载请求，结果通过该订阅的 VIEW_PATCH 返回 |
| 现有停止/挂起/恢复入口 | 改变业务状态，由展示投影推送结果 |

新会话先得到真实 root_session_id，前端不让消息依赖临时 "0" 会话定位。命令使用 command_id 保证重试幂等；回执丢失可以查询首次受理结果。受理前的等待状态放在发送控件，不创建没有 turn_id 的正式用户气泡。

执行可以早于首次订阅推进，因为展示状态先保存，首次快照会包含当前文本和工具状态。已连接根会话的后续命令复用同一条流，不为每次提问再开一个根订阅。

每个订阅维护自己的已加载窗口。初始快照包含根会话最近完整轮次页、全部活动轮次及所需子会话元数据；节点引用必须闭合。子会话历史按选择或滚动请求加载。

分页以完整 turn 为单位，不能在一个回答中间切断。单个超大 turn 的工具原始输出走详情接口；文本节点有产品容量限制。若未来增加轮次内部懒加载，需要另行制定契约，不能隐含把 blocks 缺失交给前端补猜。

历史加载结果也在该订阅的串行队列中，与当前投影位置协调后生成 VIEW_PATCH。服务端为该订阅计算完整 session.turn_ids，前端不合并、排序或拼接分页。HTTP 只回接受结果，完成/失败用 request_results 解除加载状态。

未知子会话首次出现时，后端同一批补齐目录、Session、Turn、Bubble 和相关内容，不能让前端临时造占位。点击子会话只切换视图，不重建该会话当前活动气泡。

重发与历史回滚由后端作废对应的展示节点、挡住旧执行迟到事件，再对受影响订阅发送 VIEW_RESET。重置保留订阅中仍有效的加载窗口。新 turn 使用新身份；既有 turn 的 ID 不能复用给新问题。

**12. 一个完整流的展示变化**

下面的编号仅用于说明，不进入前端状态或协议。

1. 受理：同一批发布 turn t1、用户气泡 u1(CLOSED)、助手气泡 a1(OPEN)，以及用户文本。
2. 首次调用：在 a1 下建立思考块 r1 与文本块 p1；收到文字后只更新它们的尾片。
3. 模型返回工具请求：校正 p1，设为 COMPLETE/NARRATION；按请求顺序创建工具块 k1、k2。
4. k2 先完成：覆盖 k2，卡片位置不变。
5. k1 完成：覆盖 k1，卡片位置不变。
6. 后续调用：新建 r2、p2；p1 保持原位，不被合并或覆盖。
7. 最后响应：完整校正 p2；业务完成时将其标为 ANSWER，设置复制目标与页脚位置。
8. 终结：同一批关闭 a1、更新 t1 的终态和已知统计；其他子轮次继续更新自己的视图。
9. 重连：新快照里的 t1/a1/r1/p1/k1/k2/r2/p2 保持原 ID 和位置，前端不重新聚合。

**13. 落地顺序与验收**

先固定契约和样例夹具，再实现后端身份与展示持久化；随后实现完整响应校正、业务状态提交接入、订阅快照屏障；最后接 Pinia 与各块组件，并切换历史接口。不能只接实时新协议而继续让旧历史聚合逻辑覆盖新视图。

协议属于破坏性变更，使用独立入口与 schema_version 联调，再同步切换前后端。已删除的旧 stream-v3 文件不能因为名称相似就直接恢复；新实现应围绕本契约的实体覆盖和订阅边界落地。

| 验收场景 | 必须成立的结果 |
|---|---|
| 一个 turn 多次模型调用 | 各文本块身份独立，前端没有模型轮次变量 |
| 多工具并发且逆序完成 | 只更新原卡片，不改变后端给定位置 |
| 重复应用同一合法批次 | 文本不翻倍，气泡和工具不重复 |
| 分片跨代码围栏/表格/Unicode | 拼接后的内容逐字符正确，Markdown 结构正确 |
| 完整响应修正局部文本 | block_id 不变，一次提交替换正确内容 |
| 快照生成期间继续输出 | 快照与后续批次无缺口、不回退 |
| 慢客户端队列溢出 | 断开后快照恢复，不静默丢结构变化 |
| 旧连接回调迟到 | 不修改当前订阅的视图 |
| 挂起、恢复、取消挂起执行 | 原气泡保持/终结正确，不依赖框架取消事件 |
| 受理后启动失败 | 用户气泡仍在，助手关闭，失败归属正确 turn |
| 父轮次结束而子轮次继续 | 根连接继续，子气泡独立更新 |
| 统计晚到 | 页脚补齐，气泡不重新打开 |
| 活动文本期间服务端重启 | 所有已经推送的已提交文字仍能从快照恢复 |
| 翻页同时状态变化 | 后端串行合成窗口，前端不覆盖新状态 |
| 重发后旧执行迟到事件 | 后端拒绝旧来源，删除的内容不复活 |
| 全量递归检查公开 JSON | 不含 execution_id/executionId，所有归属都有真实 turn_id |
| 持久化并发与事务回滚 | 投影/outbox 不出现半提交，相关回归测试通过 |

本次交付只新增设计文档与契约类型，没有修改现有业务、框架或数据库。类型契约检查可以证明声明自洽；上述运行时保证需要实施阶段的事务、并发、协议和界面测试证明。
