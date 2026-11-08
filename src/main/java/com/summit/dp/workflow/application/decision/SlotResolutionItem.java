package com.summit.dp.workflow.application.decision;

import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;

/**
 * 一个槽位要写入的决议：工具消息文本 + 卡片原始结论。
 *
 * @param card       锁内重读到的卡片（引擎直接在这条实例上落结论）
 * @param outputText 写回工具消息的文本（恢复后模型看到的内容）
 * @param rawOutput  卡片的原始结论 JSON
 * @param outcome    本次落定的结论（回执直接用，避免二次解析）
 */
public record SlotResolutionItem(ToolCall card, String outputText, String rawOutput, ToolCallOutcome outcome) {
}

