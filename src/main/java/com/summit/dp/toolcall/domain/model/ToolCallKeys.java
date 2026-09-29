package com.summit.dp.toolcall.domain.model;

/**
 * {@code tool_call} 各 JSON 载荷（{@code content} / {@code raw_input} / {@code raw_output} /
 * {@code meta_data}）的键名单一真源（评审 P2-⑦）。
 *
 * <p><b>为什么集中：</b>这些键名同时被写侧（{@code ToolCallConverter}）与读侧
 * （卡片形态判别 {@code kind}、命令审批快照解析、计划附件渲染）使用，前端也靠
 * {@code content.kind} 判别卡片形态、后端靠 {@code raw_output.outcome} 判结论。
 * 散落裸字符串时改一处会静默漂移、编译期无感；集中后写读两侧引用同一常量。</p>
 *
 * <p><b>不覆盖的范围：</b>已执行的迁移脚本 {@code db/manual/20260927_tool_call_refactor.sql}
 * 里还有一份等价手写，属历史迁移契约，保持原样不引用本类（改它会让已建库与新脚本不一致）。</p>
 */
public final class ToolCallKeys {

    private ToolCallKeys() {
    }

    // ------------------------------------------------------------------
    // content：多态卡片载荷
    // ------------------------------------------------------------------

    /** 卡片形态判别键（PLAN / CHOICE / COMMAND）。 */
    public static final String KIND = "kind";

    /** PLAN 卡片：标题。 */
    public static final String TITLE = "title";
    /** PLAN 卡片：正文。 */
    public static final String TEXT = "text";

    /** CHOICE 卡片：问题。 */
    public static final String QUESTION = "question";
    /** CHOICE 卡片：候选选项数组。 */
    public static final String OPTIONS = "options";

    /** COMMAND 卡片：原始命令。 */
    public static final String COMMAND = "command";
    /** COMMAND 卡片：工作目录。 */
    public static final String WORK_DIR = "workDir";
    /** COMMAND 卡片：目标 shell 名。 */
    public static final String SHELL = "shell";
    /** COMMAND 卡片：工作空间 id。 */
    public static final String WORKSPACE_ID = "workspaceId";

    // ------------------------------------------------------------------
    // raw_input：输入载荷
    // ------------------------------------------------------------------

    /** 模型下发的工具参数。 */
    public static final String ARGS = "args";

    // ------------------------------------------------------------------
    // raw_output：输出载荷
    // ------------------------------------------------------------------

    /** 结论（SUCCEEDED / FAILED / REJECTED / CANCELLED / ...）。 */
    public static final String OUTCOME = "outcome";
    /** 用户答复原文（PLAN / CHOICE 批准时）。 */
    public static final String ANSWER = "answer";
    /** 决策落定时间。 */
    public static final String DECIDED_AT = "decidedAt";
    /** 命令标准输出（APPROVED / SUCCEEDED）。 */
    public static final String STDOUT = "stdout";
    /** 命令输出 / 错误输出（FAILED / TIMED_OUT / EXECUTE 直通）。 */
    public static final String OUTPUT = "output";
    /** 取消或拒绝原因。 */
    public static final String REASON = "reason";

    // ------------------------------------------------------------------
    // meta_data：扩展元数据
    // ------------------------------------------------------------------

    /** 元数据根节点。 */
    public static final String META = "_meta";
    /** 载荷 schema 版本。 */
    public static final String SCHEMA_VERSION = "schemaVersion";
    /** 派生此次调用的执行 id（写字符串）。 */
    public static final String EXECUTION_ID = "executionId";
    /** 原始工具名。 */
    public static final String TOOL_NAME = "toolName";
}
