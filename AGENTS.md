# 项目协作规范（用户明确要求，持续适用）

## 注释与文档：按侧分语言，不要混

- **框架侧保持全英文 doc。** 指的是 `D:\code\starter` 下的框架仓（`lingxi-harness-agent`、`dev-framework-ddd-starter` 等，即 `com.summit.core.*` / `com.summit.runtime.*`），与那里的既有风格保持一致，不要改成中文。
- **业务侧（本项目 `com.summit.dp.*`）全中文 doc，且不能太长。** 一个类几行、一个方法一两句；不要写成大段设计说明，长篇推演放 `AGENTS.md` 或项目记忆里，不塞进代码。
- 不模仿英文注释的写法与语序（例如 `// step one: find the turnId from the table named ... by messageId`），也不要在中文句子里夹英文短句。字段名、类名、专有名词保持英文原样即可。
- 注释只写「为什么」：取舍理由、约束、坑与不变量（谁必须在本方法之前/之后调用、为什么不能反过来）。
- 日志统一 `中文动作: key=value, key=value`。异常消息是给用户看的业务文案，必须说清哪里不对，禁止 `invalid state` 这类无信息量的英文。
- 不留被注释掉的旧代码；要删就删干净，历史在 git 里。

## 参数校验：统一用 `throwIf`

- 业务侧 Service / Validator 里定义一个私有助手：`private void throwIf(boolean condition, String err) { if (condition) throw new ClientException(err); }`。
- **入口校验一律走它**，不写散落的 `if (...) throw new ...`。文案是中文业务提示，说清哪里不对（`"用户输入不能为空"`、`"只有用户提问可以重发"`）。

## 复杂业务入口：事务脚本，但不堆 private 方法

- 直接对接 Service 接口的复杂入口（如 `ChatServiceImpl#resend`）按**事务脚本**写：一个方法从头到尾把顺序讲清楚，步骤之间留空行，用注释标出「哪几步的顺序不能动、为什么」。
- **但不要把编排类堆成一个 private 方法仓库。** 某一步里成块的逻辑抽成独立的协作类（Service / Validator / Resolver），由入口注入、按顺序调用；入口方法里只留下属于「顺序」本身的那几行。
- 判断标准：一个 private 方法如果只为某一个入口服务，它就应该是一个独立类。

## 框架扩展点：一个模块一个实现，不挤在一个类里

- 框架扩展点支持注册**多个** bean，运行时串成一条链：`LoopInterceptor` 由 `DefaultLoopInterceptorProcessor` 按 `order()` 升序调用，值相等的保持注册顺序。每个回调返回 `InterceptorResult`，返回非「继续」即当场终止这一轮，后续实现不再执行。
- **异常默认被吃掉**（`catchErr()` 默认 `true`：只记一条 error 日志，不打失败整轮、也不阻断后面的实现）。会改变业务语义的动作必须显式 `catchErr()` 返回 `false` 让异常上抛 —— 判据是「吞掉之后世界是否还一致」：消费型、投影型动作吞掉等于静默丢数据，必须上抛。
- **每个模块写自己的实现类**（邮箱注入归 `AgenticLoopInterceptor`，工具调用收尾之类归各自模块），不要把多个模块的逻辑堆进同一个类。
- `order()` 越小越先；框架自己的 `DefaultLoopInterceptor` 占 `Integer.MIN_VALUE`（信号与预算判定，业务侧不要去抢），业务侧从 -900 起分段：新增实现给出自己的值，不要都取 0 —— 并列时先后只取决于 Spring 的注入顺序，不可依赖。
- 回调签名里的 `LoopContext` 持有的是 `Execution` 实例本身（不是 id），需要执行身份时取 `context.execution()`，不要从 attributes 里绕。

## 前端：工具名一律走枚举

- 后端固定工具名的唯一真源是 `frontend/src/utils/toolNames.ts` 的 `AgentToolName`（对齐后端 `ToolCatalog` + 各 `ToolDefinition` 注册名 + 框架内核工具），前端任何地方**不得再写工具名字面量**（`'read_file'`、`"edit_file"` 这类）。
- 实现用 `as const` 对象 + 派生联合类型，不是 `enum` —— tsconfig 开了 `erasableSyntaxOnly`，enum 语法编译不过。
- MCP 工具名是远端下发的动态集合（`mcp_` 前缀），不入枚举。

## 命名：不要 `xxxOf`

- **不用以 `of` 结尾的命名**，方法名与变量名都算：`runStatusOf(...)`、`statusOf(...)`、`kindOf(...)`、`typeOf(...)`、`sessionIdOf(...)`、`taskOf(...)`、`baselineOf(...)` 这类一律不要。
- 改用动词开头或明确的组合：`resolveXxx` / `toXxx` / `parseXxx` / `buildXxx`。
  例：`runStatusOf(states)` → `resolveRunStatus(states)`；`kindOf(json)` → `resolveKind(json)`；`typeOf(message)` → `toMessageType(message)`。
- 兜底判断：名字读起来像「A 的 B」这种名词短语就改掉，写成「做什么动作」。
- 存量代码里这类命名很多，**不强制回头改**；新写的代码和本次改动的行必须遵守。

## Java 类型声明

- 禁止使用 `var`。局部变量、循环变量、try-with-resources 变量及测试代码一律使用显式类型。
- 示例代码同样遵守，不以简洁为由省略类型。

## 持久化技术与 DDD

- 本项目已使用 MyBatis-Plus。新增或改造业务持久化必须复用现有 `PO + BaseMapper + RepositoryImpl` 方式，优先使用 LambdaQueryWrapper / LambdaUpdateWrapper。
- 禁止擅自引入原生 JDBC、JdbcTemplate、手动 Connection/PreparedStatement 或在仓储中拼接 SQL 替代现有 MyBatis-Plus。
- 确需自定义 SQL 时集中在 MyBatis Mapper/XML 中，使用参数绑定；不要绕过 Mapper。固定的锁定/分页尾句可以沿用项目 Wrapper 的既有方式，不能拼接外部输入。
- 应用层依赖领域仓储接口；PO、Mapper 和仓储实现留在基础设施层，领域层不依赖持久化框架。
- 测试中的业务数据准备、查询与修改也通过 Mapper/仓储完成；数据库建表脚本由测试框架的脚本执行器加载。
- 修改前检查现有实现风格；已有遗留 JDBC 不构成新增 JDBC 的理由，避免无关范围重写。

## DDD 开发框架与领域对象规范（用户明确要求，持续适用）

1. **领域对象更新**：更新一律通过领域方法修改非 final 字段；字段限制（如名字不可大于 10 字）以常量定义在领域模型中，rename 等变更方法先校验再赋值。应用层更新数据时，使用 `if (command.getXxx() != null) model.changeXxx(...)` 的逐字段判空结构驱动领域方法，最后统一 `updateById()`。
2. **全类名**：方法代码中尽量不要书写全类名，import 只能出现在文件顶部。
3. **框架源码位置**：本机框架源码位于 `D:\code\starter`（如 `dev-framework-ddd-starter`、`lingxi-harness-agent`），只读参考。
4. **仓储层**：必须使用 DDD 开发框架——接口继承 `RepositoryTemplate`，实现继承 `AbstractRepository`。
5. **业务参数校验**：调用仓储层返回 Optional 时，用 `orElseThrow(ClientException::new)` 抛出，由全局异常处理器统一返回错误。
6. **新模块骨架**：新建 DDD 模块优先使用框架的 `DddCodeGenerator` 生成开发骨架，再根据情况改造。

## 提交前自检

- 检查本次新增和修改代码中是否残留 `var`、新引入的 JDBC 调用，以及违反 DDD 分层的依赖。
- 持久化实现替换后必须运行相关事务、并发与回归测试。
- 对照「DDD 开发框架与领域对象规范」逐条自查：领域方法更新结构、无方法体内全类名、仓储继承框架基类、Optional 校验走 `orElseThrow(ClientException::new)`。
