# 请求停在思考中的运行依赖排查

2026-10-25 检查时，截图对应的原会话已经不存在。以下结论来自使用同一工作区与选中模型的新建诊断会话复测，不代表读取到了原请求的完整执行记录。

异步请求在 161ms 内受理，进入 RUNNING 后事件流只出现开始、上下文用量和心跳，没有模型内容或终态；线程快照中执行线程已经退出。改用同步入口后立即返回 500，后端日志暴露出 `NoSuchMethodError: ContextSqueezeRequest.builder()`，调用点是 `BoundaryChecker.shouldSqueezeContext`，位于模型调用前。

运行进程的 classpath 指向 `D:/languages/mvn/repository`：`harness-runtime` 是 10 月 23 日构建，`harness-core` 是 10 月 24 日构建，同为 `1.1.8-SNAPSHOT`，但二进制契约不同。javap 确认旧 runtime 调用 builder，而当前 core 是只有 none/summarize/prune 工厂方法的 record。这些包与项目锁定仓库 `.run/maven/b4c225dd38ed4b0c` 中的构建也不一致。

业务异步入口丢弃 CompletableFuture，执行收尾原来只捕获 RuntimeException，LinkageError 越过失败收口，导致工作线程已退出、持久化状态仍是 RUNNING。现在明确捕获 LinkageError，转换成带中文恢复提示的失败，并沿现有控制器路径保存与发布终态、释放根会话资格。此改动不吞掉内存耗尽等其他 Error，也不修复不兼容的依赖本身。

运行环境需要让 IDE 使用项目锁定仓库、重新加载 Maven 项目并重启后端，不能只重编业务代码。启动收口会把遗留 CREATED/RUNNING 执行标为失败。当前 IDE 进程未在排查中被强制终止。

另发现清理接口未加入 Vite 开发代理：直连后端返回 JSON，经 5174 返回 HTML。已补 `/execution`，并将 GET 预览与 POST 清理加入真实 Vite 代理测试；当前前端开发进程需要重启使配置生效。

验证：后端相关回归 50 项通过，包含同步/异步 LinkageError 收口；前端开发隔离回归 4 项通过。依赖错误未收口、缺失开发代理两处非等价变异均被回归拦截。测试与线程诊断文件保存在忽略目录 `.run/`，没有修改框架源码或全局 Maven 仓库。
