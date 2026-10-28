# 变异测试（Pitest）

`AGENTS.md` 的规矩是「断言必须能因缺陷变红」，唯一硬证据就是变异：把代码改坏一处，测试必须变红。
以前这事靠手工（改一处 → 跑测试 → 回退），Pitest 把它自动化：自动生成字节码级变异，逐条跑覆盖到它的测试，杀不掉的就是测试盲区。

## 什么时候跑

- 改动核心逻辑（领域状态机、解析、转换、校验）之后，对**改动所在的包**跑一遍，用它检查新断言是不是真的有效。
- 它不是门槛，是体检报告。**不要指望一次就漂亮**：第一轮总会有一批变异活着（本项目首轮 78% 被杀，剩下 22% 才是真正要看的）。
- 前置条件：`mvn -o test` 必须全绿。Pitest 第一阶段会先跑测试算行覆盖，只要有测试红/错，整轮直接失败（它无法区分「测试本来就红」和「变异被杀死」）。

## 命令

插件没有绑定生命周期，`mvn test` / `mvn package` 完全不受影响，只有显式调用才会跑。

Pitest **不会自己编译**，`target/classes` 与 `target/test-classes` 必须已存在，所以命令一律带上 `test-compile`（少了它只会得到 `No mutations found` 这句气人的提示）。

默认目标（8 个纯逻辑核心包，不用带范围参数）：

```
mvn test-compile org.pitest:pitest-maven:mutationCoverage
```

锁定单个类（改完谁就查谁，最快）：

```
mvn test-compile org.pitest:pitest-maven:mutationCoverage ^
  -DtargetClasses=com.summit.dp.toolcall.domain.model.ToolCall ^
  -DtargetTests=com.summit.dp.toolcall.*
```

按包扩大范围：

```
mvn test-compile org.pitest:pitest-maven:mutationCoverage ^
  -DtargetClasses=com.summit.dp.workflow.infrastructure.tools.* ^
  -DtargetTests=com.summit.dp.workflow.*
```

全量（很慢，慎用）：

```
mvn test-compile org.pitest:pitest-maven:mutationCoverage -DtargetClasses=com.summit.dp.*
```

增量分析**默认关闭**（默认每轮都是全量、结果可复现），要做增量才显式指定历史文件：

```
mvn test-compile org.pitest:pitest-maven:mutationCoverage ^
  -DhistoryInputFile=target/pitest/history.bin ^
  -DhistoryOutputFile=target/pitest/history.bin
```

- 第二次起只分析新增/变更的变异，同样的命中率但省掉大部分变异执行时间；结果复用时不打印「Ran N tests」（`Ran 0 tests` 是正常的，不是没跑）。
- 换过 `targetClasses` / `targetTests` 范围后，先删掉 `target/pitest/history.bin`。历史里记的是「哪些测试覆盖过哪些变异」，范围一变就对不上，会出现假的「无覆盖」或漏跑。
- 为什么要显式开：历史文件一存在，`pitest` 会不加提示地走增量，分数就不是当前代码的真实分数了，这种「静默变绿/变红」不值得为省几分钟冒险。

实测账（本机 JDK 21、16 核）：默认范围首次全量 **11 分 30 秒**（算覆盖 2 分 14 秒 + 跑变异 8 分 58 秒，默认单线程，372 个变异）。

可选门禁（默认不设阈值，否则第一次运行就红）：

- `-DmutationThreshold=70`：总变异分数低于阈值让构建失败。
- `-DtestStrengthThreshold=80`：只看被测试覆盖到的变异，被杀掉的比例。**要门禁就盯这个**，分母里没有未测代码的水分。

## 默认范围与排除

- `targetClasses`：`shared.utils`、`shared.vo.block`、`toolcall.domain.model`、`toolcall.application.convert`、`checklist.domain.model`、`turn.domain.model`、`session.domain.model`、`model.domain.model` —— 都是纯逻辑、无 IO 的包。多 glob 在 pom 里必须写成多个 `<param>`，XML 里的逗号不会被拆分（`-D` 命令行上的逗号会被 Maven 拆成数组，两条路径行为不同）。
- `excludedClasses`：`api`、`infrastructure`、`*VO`/`*PO`/`*DTO`/`*Mapper`/`*Config`、启动类。这些是结构性代码，没有可辨别的行为差异，喂进去只稀释分数、拉长耗时。
- `excludedTestClasses`：本地起端口/子进程/真实网络/长耗时的测试（网络对比、流式重试、MCP fixture、图片工具、沙箱边界等）。它们在 Pitest 的 minion 里不稳定，一条基线失败就会让整轮作废。**排除它们会降低敏感度**（只有它们能杀死的变异会被记成存活），所以这是可复现性换敏感度的取舍，不是「这些测试不重要」。

## 报告

- `target/pit-reports/index.html`：人看的明细，逐行标出被杀/存活/无覆盖。
- `target/pit-reports/mutations.xml`：机读，可归档、对比两次结果。
- 都在 `target/` 下（`.gitignore` 已忽略），`mvn clean` 一起清掉，不需要手工收拾。

## 当前基线（2026-10-28 首次完整运行，仅作参照，不是门槛）

- 生成 372 个变异，杀死 289 个（78%），**test strength 88%**，45 个变异无覆盖，覆盖到的类行覆盖 87%。
- 也就是说：这套纯逻辑核心包的测试基本能发现改坏的地方，主要缺口在「有代码没测试跑到」那一块，而不是「有测试但断言太弱」。

## 怎么读结果

| 状态 | 含义 | 该怎么办 |
| --- | --- | --- |
| Killed | 测试发现了这个变异 | — |
| Survived | 测试没发现，代码改坏了照样绿 | 真实盲区，补断言 |
| No coverage | 没有测试执行到这段代码 | 缺测试，或该类根本没被用到 |
| Timed out | 变异导致死循环/极慢 | 可能是真实缺陷，人工确认 |

- **等价变异**（语义上不可观测：日志文案、`toString`、纯展示字段）杀不掉是正常的。不许改断言粉饰，也不许删代码迁就工具；如实标注「等价变异未捕获」，必要时在 `excludedClasses`/注释里写明理由 —— 这条与 `AGENTS.md` 的变异纪律一致。
- 存活变异先看**是不是同一个断言的缺口**：一批变异同时活着，通常意味着这个类只有「正常路径」测试。

## 已知坑

- 每轮都要先跑一遍全测试套件算覆盖（默认 `targetTests` 覆盖 `src/test` 下所有包），本项目约 2~3 分钟；只想看一个包就顺手限制 `-DtargetTests`。
- 单线程跑变异是默认行为。`-Dthreads=4` 能快很多，但本项目部分测试共用一个 H2 库文件/固定端口，并行时可能互相踩，出现假失败 —— 只在纯逻辑包上开。
- 缩范围跑（`-DtargetTests=某个包.*`）时，会碰到**测试之间互相依赖**的用例：实测 `com.summit.dp.shared.InitSqlMigrationCoverageTest` 只跑 `com.summit.dp.shared.*` 子集时失败，全量 `targetTests` 下却通过。这类用例要么补齐自足初始化，要么在缩范围时排除。
- 控制台会出现 `Project uses Spring, but the Arcmutate Spring plugin is not present`：商业插件广告，忽略。
- Pitest 不负责编译：`mvn clean` 之后直接跑只会得到 `No mutations found`，命令前面必须带 `test-compile`。
- `pitest` 版本锁在 `1.21.1`：更新的 1.30.x 把内置增量分析挪进了 Arcmutate 商业插件，`historyInputFile` 一设就直接报错；`1.21.x` 还留着免费的增量分析。

## 后续可做（当前未做）

- **CI 接入**：`backend-ci.yml` 走的是锁版本框架仓构建（`npm run backend:verify`），变异测试要塞进去得复用同一套 `prepareFrameworks` 流程，且单轮时长不适合卡 PR。建议单独一个 `workflow_dispatch`（手动/nightly）作业，把 `target/pit-reports` 作为 artifact 上传。
- **测试分层**：现在环境敏感测试和纯单测混在一个测试源集里，只能靠 `excludedTestClasses` 点名排除。更彻底的做法是按 JUnit tag 或独立 test 源集把 `integration`/`e2e` 切出去，surefire 与 pitest 各取所需 —— 否则每次新增这类测试都要回来改排除清单。
