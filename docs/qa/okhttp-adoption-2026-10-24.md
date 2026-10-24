# 模型调用接入 OkHttp（2026-10-24）

LingXi 通过业务侧 `ModelHttpClientConfiguration` 提供 `HttpClientBuilderFactory`，替换框架默认 JDK 工厂。覆盖框架内置 OpenAI、Anthropic 的同步、流式、上下文压缩及图像模型；MCP 和其他业务 HTTP 调用保持各自配置。

OkHttp 连接器从测试依赖提升为正式依赖，删除不再需要的 `http-client-comparison` profile。版本为 LangChain4j 1.22.0、连接器 1.22.0-beta32、OkHttp 5.3.2、Kotlin 2.2.21。JDK 连接器仍是框架依赖，模型通过显式工厂选择客户端；直接创建 SDK 模型的测试也显式选择 OkHttp，避免多客户端自动发现冲突。

每次工厂调用返回独立 Builder，模型继续使用既有超时值。OkHttp 的读取空闲超时会在 SSE 长时间静默时终止请求，随后按框架策略决定是否重试；没有新增超时或重试配置。

## 验证

- 66 项测试通过：生产工厂选择与 Builder 隔离 1 项，网络矩阵 35 项，流式重试 9 项，模型超时 3 项，提示词优化 12 项，聊天入口 5 项，读图闭环 1 项。
- 网络矩阵默认加载生产配置，覆盖 OpenAI、Anthropic 的握手中断、证书失败、限流、服务错误、流截断、空闲超时、取消与终态事件。
- 两项变异均触发断言失败：工厂回退 JDK、复用同一个 Builder；恢复后测试通过。变异仅替换隔离构建目录中的字节码，不修改生产源码。
- 后端重新打包成功，已检查 Spring Boot JAR 包含生产配置类、OkHttp 连接器及匹配的 LangChain4j、Kotlin 依赖。
- 使用隔离构建目录 `target/okhttp-adoption`，日志为 `target/okhttp-adoption-tests.log`、`target/okhttp-adoption-integration.log`，变异证据在该构建目录的 `mutations/`。

复现相关测试：

```powershell
mvn -B -ntp "-Dlingxi.build.directory=target/okhttp-adoption" "-Dtest=ModelHttpClientConfigurationTest,HttpClientNetworkComparisonTest,StreamingRetryContractTest,RuntimeModelTimeoutTest,PromptOptimizationTest,ChatControllerLifecycleTest,ReadImageLoopIntegrationTest" test
```

这里验证的是本地 HTTP/TLS 故障与业务入口，没有调用公网模型服务，也不代表现有桌面进程已经升级。新配置在使用新后端包启动后生效。
