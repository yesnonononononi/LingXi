package com.summit.dp.toolcall.infrastructure.persistence;

import com.summit.dp.shared.exception.ClientException;

/**
 * 乐观锁版本自增的通用算法。
 *
 * <p><b>为什么独立成类</b>：带版本条件的更新最容易漏掉「影响行数不等于 1 就当失败处理」
 * 这一步 —— 漏掉它，并发下会静默丢更新还向上层报成功。这里的实现把「条件更新 + 判行数
 * + 抛业务异常」三件事收在一处，让它无法被无意省掉。</p>
 */
public final class VersionedUpdate {

    /** 条件更新后的影响行数与期望值不符时的统一文案。 */
    private static final String CONFLICT = "工具调用状态已变化，请刷新后重试";

    private VersionedUpdate() {
    }

    /**
     * 校验一次版本条件更新的影响行数。
     *
     * <p>约定：条件不匹配返回 0（MyBatis-Plus 的 {@code update} 语义）。因此
     * 「返回 0」= 行不存在或版本已被他人推进，两者都必须当作冲突报给用户。</p>
     *
     * @param changed 影响行数
     * @throws ClientException 影响行数不为 1
     */
    public static void requireSingleRow(int changed) {
        if (changed != 1) {
            throw new ClientException(CONFLICT);
        }
    }

    /** 落库后的新版本号。 */
    public static long nextVersion(long currentVersion) {
        return currentVersion + 1;
    }
}
