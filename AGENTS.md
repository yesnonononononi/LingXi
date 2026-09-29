# 项目协作规范（用户明确要求，持续适用）

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
