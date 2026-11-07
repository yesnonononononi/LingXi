
package com.summit.dp.workflow.application.projection;

import com.summit.dp.execution.ExecutionEventMetadata;

import java.util.Map;

/**
 * 一次实时推送的<b>权威归属</b>：业务轮次、轮次所属会话、以及传输路由用的根会话。
 *
 * <p><b>为什么要有这个类型</b>：框架的每次执行事件都带着受控的归属快照
 * （{@link ExecutionEventMetadata}：{@code turnId} / {@code sessionId} / {@code rootSessionId}），
 * 而推送路径此前只拿到框架的 {@code executionId}，于是先用它反查 {@code chat_turn}，
 * 再拿会话去解析根会话 —— 一次工具事件要为此付出三轮查询。把事件里的归属当成入参带着走，
 * 这些反查就都不需要了。</p>
 *
 * <p><b>三个字段必须同时齐备</b>：缺任一键就不是「权威归属」，只能整份回退到原有的反查路径。
 * 半份元数据（例如有会话、没有轮次）不省任何查询，反而会让「哪一条是权威」变得含糊 ——
 * 归属这类决定投递目标的东西，宁可整份放弃也不要拼。旧检查点里没有这两个键，回退是它的正常出口。</p>
 *
 * <p><b>路由与会话分开</b>：{@code sessionId} 是块的真实归属（子会话就是子会话自身），
 * {@code rootSessionId} 只用于把帧投到订阅了根会话的那条流上。两者混用会因子会话与根会话
 * 「哨兵 0」而投错桶。</p>
 *
 * @param turnId        业务轮次 ID；推送内容的归属轮次
 * @param sessionId     该轮次所属会话 ID；块内容的归属会话
 * @param rootSessionId 传输路由用的根会话 ID
 */
public record TurnBroadcastIdentity(Long turnId, Long sessionId, Long rootSessionId) {

    /**
     * 从框架事件元数据解析权威归属。
     *
     * <p>解析规则全部复用 {@link ExecutionEventMetadata}（元数据键是十进制字符串），
     * 不在这里另写一份键名与格式判断 —— 两处各判一次，迟早出现「一边认、一边不认」。</p>
     *
     * @param metadata 事件元数据；{@code null} 或空表示该事件不带归属
     * @return 三键齐备时的权威归属；缺任一键返回 {@code null}（调用方整份回退）
     */
    public static TurnBroadcastIdentity fromEventMetadata(Map<String, Object> metadata) {
        if (metadata == null || metadata.isEmpty()) {
            return null;
        }
        Long turnId = ExecutionEventMetadata.turnId(metadata);
        Long sessionId = ExecutionEventMetadata.sessionId(metadata);
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(metadata);
        if (turnId == null || sessionId == null || rootSessionId == null) {
            return null;
        }
        return new TurnBroadcastIdentity(turnId, sessionId, rootSessionId);
    }

    /**
     * 判断元数据声称的归属与落库轮次的归属是否一致。
     *
     * <p><b>一致性必须校验</b>：元数据是执行开始时的快照，库里那行才是当前事实。两者不一致说明
     * 这条事件不该投到那个会话（例如事件被复用、快照过期）。此时唯一正确的动作是丢弃，
     * 绝不能拿任一方的值凑合着发出去 —— 那等于把一帧内容静默改投到别的会话。</p>
     *
     * @param turnSessionId 轮次行上的会话 ID；{@code null} 视为无法确认
     * @return 两者都非空且相等时为 {@code true}
     */
    public boolean matchesTurnSession(Long turnSessionId) {
        return sessionId != null && turnSessionId != null && sessionId.equals(turnSessionId);
    }
}
