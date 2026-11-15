package com.summit.dp.workflow.application.decision;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * 审批形态 → 处理器的唯一查找点。
 *
 * <p>重复注册当场失败：两个实现抢同一形态时，谁生效取决于 bean 注入顺序，
 * 那属于不可依赖的行为，必须在启动期就炸掉。</p>
 */
@Component
public class ApprovalKindHandlers {

    private final Map<ToolCallKind, ApprovalKindHandler> byKind;

    /**
     * 两个构造器时必须显式指定容器用哪个：Spring 在「多构造器且都无注解」时不会去猜，
     * 会在启动期直接失败。
     */
    @Autowired
    public ApprovalKindHandlers(List<ApprovalKindHandler> handlers) {
        Map<ToolCallKind, ApprovalKindHandler> collected = new EnumMap<>(ToolCallKind.class);
        for (ApprovalKindHandler handler : handlers) {
            ApprovalKindHandler previous = collected.put(handler.kind(), handler);
            if (previous != null) {
                throw new IllegalStateException("审批形态重复注册: kind=" + handler.kind()
                        + ", 实现=" + previous.getClass().getSimpleName()
                        + " / " + handler.getClass().getSimpleName());
            }
        }
        this.byKind = Map.copyOf(collected);
    }

    /** 单测便捷构造：直接给出若干处理器，省掉造 List 的噪声。 */
    public ApprovalKindHandlers(ApprovalKindHandler... handlers) {
        this(List.of(handlers));
    }

    /** 该形态是否走两阶段审批；{@code null}（形态不可识别）一律不算。 */
    public boolean supports(ToolCallKind kind) {
        return kind != null && byKind.containsKey(kind);
    }

    /** 取该形态的处理器；未注册说明链路坏了，不能当成「无需审批」静默放行。 */
    public ApprovalKindHandler require(ToolCallKind kind) {
        ApprovalKindHandler handler = kind == null ? null : byKind.get(kind);
        if (handler == null) {
            throw new ClientException("该互动形态不支持两阶段审批: kind=" + kind);
        }
        return handler;
    }
}
