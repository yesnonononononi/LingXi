package com.summit.dp.shared.model;

import lombok.NonNull;

import java.io.Serializable;
import java.util.Set;

/** 工具目录：Agent 可配置工具的唯一合法来源。 */
public interface ToolCatalog {

    /** 委派（召唤子 Agent）工具名：仅指挥者可用 */
    String CALL_SUB_AGENT = "call_sub_agent";

    String CREATE_PLAN = "create_plan";

    String SEND_MAIL_TO_AGENT = "send_mail_to_agent";

    /**
     * 工具检索工具名。MCP 工具名要等握手后才存在，无法预先进 {@code AgentRequest.toolList}，
     * 由它让模型按需检索本次可调用的工具，而不必把全部工具一次性暴露。
     */
    String SEARCH_TOOL = "search_tool";

    /** 当前已注册的全部工具名 */
    Set<String> names();

    /**
     * 当前已注册的只读工具名。
     *
     * <p>只读档位只需「剔除写工具」，而不是把工具集替换成一份手写清单——后者会连同
     * {@link #CREATE_PLAN}、{@code require_choice} 这类无写副作用的工具一起丢掉。
     * 判定依据是工具自身的 {@code ConcurrentPolicy.READ_ONLY}，与注册表保持同源。</p>
     */
    Set<String> readOnlyNames();

    /** 工具是否已注册 */
    default boolean contains(String toolName) {
        return toolName != null && names().contains(toolName.trim());
    }

    /** 是否为指挥者专属的委派工具 */
    default boolean isDelegationTool(String toolName) {
        return CALL_SUB_AGENT.equals(toolName == null ? null : toolName.trim());
    }
}
