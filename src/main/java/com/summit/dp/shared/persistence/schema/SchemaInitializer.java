package com.summit.dp.shared.persistence.schema;

import javax.sql.DataSource;

/** H2 的 DDL 会隐式提交，失败恢复依赖幂等脚本与最后登记版本。 */
public interface SchemaInitializer {

    /** 引擎标识仅用于建库日志。 */
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
