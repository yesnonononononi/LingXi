package com.summit.dp.shared.persistence.schema;

import javax.sql.DataSource;

/**
 * 建库脚本的执行器抽象：每个存储引擎一个实现，启动时只跑被选中的那个。
 *
 * <p>接口只承诺一件事：把「还没执行过的版本脚本」按序执行完，并把执行条数报回去。
 * 事务性由各实现自己声明——SQLite 可以整段回滚，H2 的 DDL 会隐式提交，承诺不了整事务回滚，
 * 因此调用方不得假设「失败即无痕」，只能依赖幂等 + 版本登记时机来保证可重入。</p>
 */
public interface SchemaInitializer {

    /** 本实现对应的引擎标识（{@code sqlite} / {@code h2}），用于日志与装配校验。 */
    String engineId();

    /**
     * 执行所有尚未登记的版本脚本。
     *
     * @param dataSource 目标库，不能为 {@code null}
     * @return 本次实际执行的脚本个数；{@code 0} 表示库已是最新
     * @throws IllegalStateException 脚本缺失、含破坏性语句、执行失败或对象校验未通过
     */
    int initialize(DataSource dataSource);
}
