package com.summit.dp.workflow.application.pending;

import org.springframework.web.multipart.MultipartFile;

import java.util.List;

/**
 * 编辑一条待发送消息时提交的全部内容。
 *
 * <p>文本与附件是「补丁」语义：{@code input} 留空表示只改别的，{@code keepAttachmentIds}
 * 为 {@code null} 表示附件不动。而 {@code requirePlan} / {@code modelId} / {@code agentId}
 * 是「整笔覆盖」：编辑面板总能算出当前界面的选择，缺省当成「不改」只会让界面上显示的
 * 模型与实际派发的模型悄悄不一致。</p>
 *
 * @param input            新正文；空表示不修改
 * @param keepAttachmentIds 要保留的附件 id；{@code null} 表示附件不动，空列表表示全部丢掉
 * @param images           这次新追加的图片
 * @param requirePlan      是否先出计划
 * @param modelId          指定模型；{@code null} 表示不指定（由 Agent 预设或会话默认决定）
 * @param agentId          指定执行体；{@code null} 表示不指定
 */
public record PendingTaskUpdate(String input, List<String> keepAttachmentIds, List<MultipartFile> images,
                                boolean requirePlan, Long modelId, Long agentId) {
}
