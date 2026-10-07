package com.summit.dp.shared.model;


import com.summit.kernel.tools.mcp.ListMcpToolsExecutor;
import com.summit.kernel.tools.search.SearchToolExecutor;
import com.summit.kernel.tools.skill.ReadSkillTool;

import java.util.List;
import java.util.Set;

/** 工具目录：Agent 可配置工具的唯一合法来源。 */
public interface ToolCatalog {

    /** 委派（召唤子 Agent）工具名：仅指挥者可用 */
    String CALL_SUB_AGENT = "call_sub_agent";

    String CREATE_PLAN = "create_plan";

    String SEND_MAIL_TO_AGENT = "send_mail_to_agent";

    /** 终端命令工具名 */
    String EXECUTE_COMMAND = "execute_command";

    /** 读文件工具名 */
    String READ_FILE = "read_file";

    /** 改文件工具名 */
    String EDIT_FILE = "edit_file";

    /** 联网检索工具名 */
    String WEB_SEARCH = "web_search";

    /**
     * 默认 Agent（不指定团队、也不指定具体 Agent）的基础工具清单：终端 + 文件读写 + 联网检索。
     *
     * <p>这四项是「能干活」的最小集合，且都不带身份前置条件——不需要团队、不需要 Agent 绑定，
     * 所以裸模型档位给了就能用。协作类工具刻意不在列：它们要么需要团队（{@code call_sub_agent}），
     * 要么需要发件人身份（{@code send_mail_to_agent}），给了也只会一调用就报错。</p>
     *
     * <p>只读档位不必在这里分叉：{@code RequestPreparer.toolListOf} 会按注册表的只读标记剔除写工具，
     * 这个清单在只读模式下自动收敛成 {@code read_file + web_search}。</p>
     */
    List<String> DEFAULT_AGENT_TOOLS =
            List.of(EXECUTE_COMMAND, READ_FILE, EDIT_FILE, WEB_SEARCH);

    /**
     * 工具检索工具名。实现归框架侧（{@code harness-kernel-tools} 的 {@link SearchToolExecutor}），
     * 这里转发常量而非另写字面量：该名字同时被系统提示词与框架披露账本引用，各写一遍迟早漂移。
     */
    String SEARCH_TOOL = SearchToolExecutor.NAME;

    /** MCP 工具清单工具名，与 {@link #SEARCH_TOOL} 同属渐进披露的两级入口，同样转发框架常量。 */
    String LIST_MCP_TOOLS = ListMcpToolsExecutor.NAME;

    /**
     * Skill 正文读取工具名。实现归框架侧（{@code harness-kernel-tools} 的 {@link ReadSkillTool}），
     * 这里同样转发常量而非另写字面量：该名字同时被框架渲染的 Skill 提示词与工具注册表引用，
     * 各写一遍迟早漂移。
     */
    String READ_SKILL = ReadSkillTool.NAME;

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
