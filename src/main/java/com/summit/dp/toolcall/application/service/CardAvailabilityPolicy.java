package com.summit.dp.toolcall.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.domain.lifecycle.ExecutionActivity;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * 「这张卡片现在能不能接受人工决策」的判定策略，按 {@link ToolCallKind} 分派。
 *
 * <p><b>为什么独立成类</b>：卡片可用性此前在展示侧（{@code ToolCallActionResolver}）与
 * 提交侧（{@code ToolCallServiceImpl#decide}）各判一次，两边的「执行是否还活着」
 * 口径一旦漂移，就会出现「按钮亮着但点不动」或反之。</p>
 *
 * <p><b>刻意不合并两边的判定顺序</b>：展示侧对 {@code IN_PROGRESS} 回「正在处理中」的原因文案，
 * 提交侧对同一状态回一个立即完成的流（幂等 no-op，不报错）。两者对外表现不同是刻意的，
 * 本类只提供共用的判定原语（形态规则 + 执行存活），顺序仍由各自调用方决定。</p>
 */
@Service
@RequiredArgsConstructor
public class CardAvailabilityPolicy {

    private final ObjectProvider<ExecutionRepository> executions;
    private final ObjectProvider<ExecutionActivity> activity;

    /** 执行是否仍在进程内活跃（跑着或正在退出）；活跃期间不接受任何人工决策。 */
    public boolean isExecutionActive(String executionId) {
        return activity.getObject().isActive(executionId);
    }

    /**
     * 执行是否停在可接受决策的挂起点。
     *
     * @return {@link ExecutionGate#SUSPENDED} 表示可决策；{@code UNKNOWN} 表示执行数据查不到
     */
    public ExecutionGate resolveExecutionGate(String executionId) {
        if (isExecutionActive(executionId)) {
            return ExecutionGate.ACTIVE;
        }
        Execution execution = executions.getObject().findById(executionId).orElse(null);
        if (execution == null) {
            return ExecutionGate.UNKNOWN;
        }
        return execution.getExecutionState() == ExecutionState.SUSPENDED
                ? ExecutionGate.SUSPENDED : ExecutionGate.NOT_SUSPENDED;
    }

    /**
     * 按形态取规则：需要哪个 content 键、开放哪些动作。
     *
     * <p>{@code null}（形态不可识别）与 {@link ToolCallKind#EXECUTE}（无卡片载荷的普通工具）
     * 都返回 {@code null} 规则 —— 调用方据此判定「互动数据不可用」。</p>
     */
    public KindRule resolveRule(ToolCallKind kind) {
        // null 与 EXECUTE 都落到 default：形态不可识别与「无卡片载荷的普通工具」同样不可决策。
        return switch (kind == null ? ToolCallKind.EXECUTE : kind) {
            case PLAN -> new KindRule(ToolCallKeys.TEXT, approveOrReject());
            case CHOICE -> new KindRule(ToolCallKeys.QUESTION, List.of(ToolCallAction.ANSWER.wireValue()));
            case COMMAND -> new KindRule(ToolCallKeys.COMMAND, approveOrReject());
            case EXECUTE -> new KindRule(null, List.of());
        };
    }

    /** 是否人工可决策的形态（自动回填 / 无卡片载荷的形态不算）。 */
    public boolean isHumanDecision(ToolCallKind kind) {
        return kind == ToolCallKind.PLAN || kind == ToolCallKind.CHOICE || kind == ToolCallKind.COMMAND;
    }

    /** 规则的必要 content 键是否已填；{@code requiredKey} 为 null 表示该形态无内容要求。 */
    public boolean hasRequiredContent(KindRule rule, JsonNode content) {
        return rule == null || rule.requiredContentKey() == null
                || !content.path(rule.requiredContentKey()).asText().isBlank();
    }

    /** 槽位本身是否处于未决态；已收尾的槽位不再开放任何动作。 */
    public boolean isUnresolved(ToolCall tool) {
        return tool.isUnresolved();
    }

    private static List<String> approveOrReject() {
        return List.of(ToolCallAction.APPROVE.wireValue(), ToolCallAction.REJECT.wireValue());
    }

    /** 执行侧闸门结论。 */
    public enum ExecutionGate {
        /** 已挂起且控制信号已退出：可接受决策。 */
        SUSPENDED,
        /** 执行仍在进程内活跃。 */
        ACTIVE,
        /** 执行数据查不到（被清理或 id 不对）。 */
        UNKNOWN,
        /** 执行不在挂起态（运行中或已终结）。 */
        NOT_SUSPENDED
    }

    /**
     * 某形态的卡片规则。
     *
     * @param requiredContentKey 提交决策前必须存在的 content 键；无要求为 {@code null}
     * @param allowedActions 下发给前端的动作字面量
     */
    public record KindRule(String requiredContentKey, List<String> allowedActions) {
    }
}
