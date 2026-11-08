package com.summit.dp.session.domain.model;

import com.summit.dp.shared.exception.ClientException;

/**
 * 持久层承认的两种事实状态。
 *
 * <p>{@code CAPTURING} 不在这里：它是对「此刻快照总量与实时总量是否相等」的判定，
 * 落库即过期，只能由 {@link SessionTokenAudit#resolveDisplayState(Long)} 现算。</p>
 */
public enum TokenAuditPersistedState {

    /** 采集成功，快照可用。 */
    COLLECTED,
    /** 采集失败（转换或落库异常），只有失败原因可用。 */
    FAILED;

    /**
     * 按持久化名还原状态。
     *
     * @param name 持久化名，不区分大小写
     * @return 对应枚举
     * @throws ClientException 名字为空或不合法（列是 NOT NULL，出现空值即数据损坏）
     */
    public static TokenAuditPersistedState fromName(String name) {
        if (name == null || name.isBlank()) {
            throw new ClientException("token 审计持久状态不能为空");
        }
        for (TokenAuditPersistedState state : values()) {
            if (state.name().equalsIgnoreCase(name.strip())) {
                return state;
            }
        }
        throw new ClientException("无法识别的 token 审计持久状态: " + name);
    }
}
