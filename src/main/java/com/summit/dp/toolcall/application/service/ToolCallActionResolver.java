package com.summit.dp.toolcall.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy.ExecutionGate;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy.KindRule;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * 持久化状态相同，执行可用性也可能已变化，按钮不能只看 pending。
 *
 * <p>判定原语（形态规则、执行存活闸门）委托给 {@link CardAvailabilityPolicy}，
 * 本类只负责「按什么顺序解释这些原语」以及对外的原因文案。</p>
 */
@Service
@RequiredArgsConstructor
public class ToolCallActionResolver {

    private final CardAvailabilityPolicy policy;

    public Availability resolveActions(ToolCall tool, ToolCallKind kind, JsonNode content) {
        if (!policy.isUnresolved(tool)) return new Availability(List.of(), null);
        if (tool.getStatus() == ToolCallStatus.PREPARING) return new Availability(List.of(), "互动正在准备，请稍候");
        if (tool.getStatus() == ToolCallStatus.IN_PROGRESS) return new Availability(List.of(), "互动正在处理中");
        if (kind == ToolCallKind.DELEGATION) return new Availability(List.of(), "等待子代理执行结果");
        if (tool.getExecutionId() == null || kind == null || content == null
                || kind == ToolCallKind.EXECUTE) return new Availability(List.of(), "互动数据不可用，请刷新状态");

        KindRule rule = policy.resolveRule(kind);
        if (!policy.hasRequiredContent(rule, content)) {
            return new Availability(List.of(), "互动内容缺失，无法提交决策");
        }

        // 顺序有意保持「活跃 → 查不到 → 非挂起」：活跃时不查库，避免给正在跑的执行补一次无谓查询。
        ExecutionGate gate = policy.resolveExecutionGate(String.valueOf(tool.getExecutionId()));
        return fromGate(rule, gate);
    }

    /**
     * 纯计算入口：执行侧闸门由调用方提供，<b>不查执行表也不查活跃状态</b>。
     *
     * <p>用于「提交事件」这类已经持有执行事实的场景 —— 领域写入成功后组装提交事实时，执行状态
     * 是已知的（就是刚刚挂起并提交的那一个），再回查一次既多余又可能读到并发转移后的新状态。
     * bootstrap 场景可批量读执行摘要后逐卡调用本方法，避免逐卡查询（§7）。</p>
     *
     * @param gate 调用方已解析的执行侧闸门（通常由批量读取的执行摘要得出）
     */
    public Availability resolveActions(ToolCall tool, ToolCallKind kind, JsonNode content, ExecutionGate gate) {
        if (!policy.isUnresolved(tool)) return new Availability(List.of(), null);
        if (tool.getStatus() == ToolCallStatus.PREPARING) return new Availability(List.of(), "互动正在准备，请稍候");
        if (tool.getStatus() == ToolCallStatus.IN_PROGRESS) return new Availability(List.of(), "互动正在处理中");
        if (kind == ToolCallKind.DELEGATION) return new Availability(List.of(), "等待子代理执行结果");
        if (kind == null || content == null || kind == ToolCallKind.EXECUTE) {
            return new Availability(List.of(), "互动数据不可用，请刷新状态");
        }

        KindRule rule = policy.resolveRule(kind);
        if (!policy.hasRequiredContent(rule, content)) {
            return new Availability(List.of(), "互动内容缺失，无法提交决策");
        }
        return fromGate(rule, gate);
    }

    /** 执行闸门 → 可用性结论；查询侧与纯计算侧共用同一映射。 */
    private static Availability fromGate(KindRule rule, ExecutionGate gate) {
        return switch (gate) {
            case ACTIVE -> new Availability(List.of(), "执行仍在运行或退出，请稍候");
            case UNKNOWN -> new Availability(List.of(), "执行数据不可用，请刷新状态");
            case NOT_SUSPENDED -> new Availability(List.of(), "执行当前不可接受决策");
            case SUSPENDED -> new Availability(rule.allowedActions(), null);
        };
    }

    public record Availability(List<String> allowedActions, String unavailableReason) { }
}
