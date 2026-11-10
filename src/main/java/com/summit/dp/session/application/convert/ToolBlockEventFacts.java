package com.summit.dp.session.application.convert;

import java.util.Map;

/**
 * 工具块的事件权威事实。
 *
 * <p><b>为什么单独成形</b>：框架的 {@code ToolCallStartEvent} / {@code ToolCallEndEvent} 已经带齐
 * {@code responseId} / {@code requestIndex} / {@code toolName} / {@code args}，单块推送不必再回查
 * 整轮 {@code session_message} 去找「哪个响应请求了它」。跨模块传递时用这个记录，避免工作流层
 * 把框架事件类型漏进会话层的装配器。</p>
 *
 * <p><b>为什么连事件元数据一起带</b>：编辑行号（{@code _meta.fileEdit}）只在事件里那一瞬间存在，
 * 单块增量帧若不带它，推给前端的就是一个「行号全空」的块 —— 前端会把已经拿到的行号覆盖成空，
 * 表现为流式期间 diff 行号人间蒸发。带一份元数据引用即可，不必回查 {@code meta_data} CLOB，
 * 「单块不读 CLOB」的约束照旧成立。键名解析统一由装配器负责，本记录只当载体。</p>
 *
 * @param toolCallId   工具调用 ID（块身份 {@code tool:<toolCallId>}）
 * @param responseId   框架下发的模型响应身份（纯数字，由装配器统一校验）
 * @param requestIndex 该调用在所属模型响应里的零基位置（决定块内顺序）
 * @param toolName     模型请求的工具名（工具行缺失时块的展示名）
 * @param args         模型请求的原始参数 JSON 文本
 * @param metaData     事件元数据（取 {@code fileEdit} 用；可为空，不为 {@code null}）
 */
public record ToolBlockEventFacts(String toolCallId, String responseId, int requestIndex,
                                  String toolName, String args, Map<String, Object> metaData) {

    public ToolBlockEventFacts {
        metaData = metaData == null ? Map.of() : Map.copyOf(metaData);
    }

    /** 无元数据的构造：工具开始帧等场景行号必然为空。 */
    public ToolBlockEventFacts(String toolCallId, String responseId, int requestIndex,
                              String toolName, String args) {
        this(toolCallId, responseId, requestIndex, toolName, args, Map.of());
    }
}
