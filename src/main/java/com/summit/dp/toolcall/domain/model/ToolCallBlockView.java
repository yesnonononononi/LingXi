package com.summit.dp.toolcall.domain.model;

/**
 * 单块推送用的只读投影：只保留装配一个工具块真正用到的字段。
 *
 * <p><b>这不是领域实体，字段是不完整的</b>（缺 content / raw_input / meta_data）。
 * 它<b>只允许用来装配块</b>，严禁流入 {@code updateById} —— 那会把缺省的 CLOB 列抹成 null。
 * 需要完整模型请走 {@code ToolCallRepository#findById}。</p>
 *
 * @param id             工具调用 ID
 * @param conversationId 归属会话（推送路由判空用）
 * @param toolName       工具名（缺省时块里回退为模型请求的名字）
 * @param type           工具调用形态（EXECUTE / PROMISE）
 * @param status         生命周期状态
 * @param rawOutput      原始输出（块状态与展示结果都靠它）
 * @param version        乐观锁版本号（随块下发，前端据此丢弃乱序旧帧）
 */
public record ToolCallBlockView(
        String id,
        Long conversationId,
        String toolName,
        ToolCallType type,
        ToolCallStatus status,
        String rawOutput,
        Long version) {
}
