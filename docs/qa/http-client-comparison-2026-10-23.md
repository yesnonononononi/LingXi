# JDK 与 OkHttp 网络调用对比（2026-10-23）

保留 JDK 默认实现，允许应用通过 `HttpClientBuilderFactory` 选择 OkHttp 或其他实现。本轮没有测出 OkHttp 稳定的延迟、连接复用或常见网络错误恢复优势；明确差异是读取空闲超时。替换连接器不能替代框架的异常分类。

## 已完成的改动

- 七个模型 Provider 全部支持工厂构造注入，覆盖 OpenAI、Anthropic 的同步、流式、压缩模型，以及图像模型。每次创建模型取得独立 Builder，避免并发超时串配置。
- Spring 支持应用声明 `HttpClientBuilderFactory` Bean；默认工厂与无参构造保持 JDK。连接组件不进入 `harness-core` 的模型配置。
- 修复远端中断 TLS 握手没有重试的问题。证书校验失败、未知 TLS 错误保持不自动重试。
- 修复 OkHttp 将响应截断报告为 `ProtocolException: unexpected end of stream` 时未进入重试的问题；其他协议错误保持原有处理。
- 框架已执行本地 Maven install，业务框架锁更新为 `a09ce517ab0801e70b91b48332514014ebb151b8`。OkHttp 仅进入可选测试配置，生产默认客户端没有切换。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 框架全模块测试与 install | 630 项，0 失败、0 错误、13 跳过 |
| JDK 业务测试 | 59 项全部通过，包含 35 项连接器对比测试和 24 项既有回归 |
| OkHttp 业务测试 | 同一套 35 项连接器对比测试全部通过 |
| 框架锁与后端构建脚本测试 | 11 项全部通过 |
| 变异验证 | 共享 Builder、七个 Provider 绕过工厂、TLS 分类回退、响应截断分类回退、证书错误放行均使断言变红 |

框架跳过项涉及既有宿主环境、沙箱等集成条件。本轮业务网络矩阵为 17 个场景 × 2 个模型协议，另有一项连接复用测试。测试调用真实的本地 HTTP/TLS 服务，经 Spring 注册、模型选择、SDK、Agent 循环、重试/取消、执行终态及业务 SSE 事件序列化出口。执行快照使用框架内存仓储，没有访问真实业务数据库。

## 网络场景对比

测试统一配置：单次模型超时 350 ms，框架最多重试 2 次，测试退避为 0。次数包含首次调用。OpenAI 与 Anthropic 的结果一致。

| 场景 | JDK | OkHttp |
| --- | --- | --- |
| 正常完成 | 1 次调用成功 | 1 次调用成功 |
| 首次 503、429、SSE overloaded_error | 2 次调用成功，1 条重试事件 | 相同 |
| 响应体截断 | 2 次调用成功 | 修复分类后 2 次调用成功 |
| 首次响应头超时 | 2 次调用成功 | 相同 |
| 请求发送后、响应头前断开 | 2 次调用成功，2 次 HTTP 请求 | 相同；本场景没有减少框架重试 |
| 持续 503、连接拒绝 | 3 次调用后失败，2 条重试事件 | 相同 |
| 持续 TLS 握手中断 | 修复后尝试 3 次，服务持续中断所以最终失败 | 相同 |
| 401、额度不足、证书不受信任 | 1 次调用后失败，不重试 | 相同 |
| 收到 SSE 数据后静默 1.2 秒 | 未因 350 ms 超时中断，等待原响应完成 | 触发读取空闲超时，重试后成功 |
| 每 80 ms 持续产生数据，总时长超过 800 ms | 1 次调用成功 | 相同，读取空闲超时没有误当作总时长限制 |
| 响应头后无业务数据时取消、首个文本片段后取消 | 终态 CANCELLED，连接关闭，没有重试与后续文本 | 相同 |

读取空闲场景的实际耗时见下表。OkHttp 通过放弃原请求、重新生成获得较早结果，HTTP 请求数也由 1 增至 2；这不是同一条流传输得更快。真实模型可能在思考期间长时间不输出，空闲阈值应结合模型行为设置。

| 协议 | JDK 耗时（ms） | OkHttp 耗时（ms） |
| --- | --- | --- |
| OPENAI | 1276.4 | 446.6 |
| ANTHROPIC | 1242.8 | 415.0 |

首轮对比曾复现 OkHttp 两个协议的截断恢复失败；保留了修复前日志与测量。修复前的远端握手中断，两种连接器都只有一次模型调用；修复后才都能消耗框架重试预算。上述改善来自框架分类修复，不能计入更换 OkHttp 的独有收益。

## 预热计时

单并发、本机 HTTP/1.1、短 SSE 响应；每轮先预热 20 次，再记录 100 次。按 JDK → OkHttp 交替运行三轮，耗时包含 Agent 执行与业务事件序列化。

| 轮次 | JDK P50 / P95（ms） | OkHttp P50 / P95（ms） | 连接数 |
| --- | --- | --- | --- |
| 1 | 3.02 / 5.58 | 3.39 / 5.79 | 两者各 120 次请求共用 1 条连接 |
| 2 | 3.41 / 5.33 | 9.15 / 19.47 | 两者各 120 次请求共用 1 条连接 |
| 3 | 11.43 / 26.14 | 9.13 / 29.09 | 两者各 120 次请求共用 1 条连接 |

计时波动明显，优势方向会反转，不能据此认定某个客户端在真实模型调用中更快。本轮没有证明高并发吞吐、内存或线程资源优势，也没有使用生产模型接口做跨公网可用性评估。保留 JDK 默认更符合当前证据；需要明确的 SSE 空闲超时或 OkHttp 专用诊断、连接策略时，可按应用需求选择 OkHttp。

## 复现

先在框架仓运行：

```powershell
mvn -B -ntp "-Dgpg.skip=true" "-Dmaven.javadoc.skip=true" install
```

在业务仓先运行 JDK，再运行 OkHttp：

```powershell
mvn -B -ntp "-Dtest=HttpClientNetworkComparisonTest,StreamingRetryContractTest,RuntimeModelTimeoutTest,PromptOptimizationTest" "-Dlingxi.network.client=JDK" test
mvn -B -ntp -Phttp-client-comparison "-Dtest=HttpClientNetworkComparisonTest" "-Dlingxi.network.client=OKHTTP" test
```

预热计时可单独运行，分别将连接器设为 JDK、OKHTTP，并交替重复三轮：

```powershell
mvn -B -ntp -Phttp-client-comparison "-Dtest=HttpClientNetworkComparisonTest#recordsWarmLatencyAndConnectionReuse" "-Dlingxi.network.client=JDK" "-Dlingxi.network.warmup=20" "-Dlingxi.network.samples=100" test
```

可通过 `lingxi.network.output` 指定 JSON 输出文件。OkHttp 测试配置将 Kotlin 对齐到 2.2.21，避免 Spring Boot 的旧版本管理覆盖连接器所需版本。两个连接器的选择都通过框架的正式工厂入口完成；业务测试没有直接构建 LangChain4j 模型绕过 Provider。

## 证据与范围

- 可提交的测量数据：[JSON](http-client-comparison-2026-10-23.json)，包含 68 条协议/场景记录和六轮各 100 次计时原始值。
- 本地原始日志与修复前数据：`D:/Code/LingXi/.lingxi/diagnostics/http-client-comparison/`。
- 测试环境：Windows 11 amd64，Oracle JDK 21.0.12.1，LangChain4j 1.22.0，OkHttp 连接器 1.22.0-beta32，OkHttp 5.3.2。
- 该测试验证后端业务事件，不代表浏览器渲染、真实数据库事务、跨实例恢复或公网供应商稳定性已验证。
- 安装包未重新打包，运行中的旧桌面后端不会因本地 Maven install 自动升级。
- 框架提交目前位于本地；远端构建使用新的框架锁之前，需要先推送对应框架提交。
