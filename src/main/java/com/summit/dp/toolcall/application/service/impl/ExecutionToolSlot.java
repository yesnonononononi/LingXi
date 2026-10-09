package com.summit.dp.toolcall.application.service.impl;

import com.summit.core.agent.Execution;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.dp.shared.exception.ClientException;

import java.util.List;

/**
 * 执行内「待回填工具槽位」的定位与写入。
 *
 * <p>PROMISE 工具（PLAN / CHOICE / COMMAND / DELEGATION）挂起时，框架会在执行消息里留下
 * 一条占位 {@link ToolMessageEntity}；恢复前由决策方（{@code decide} / 委派回填）把真实结论
 * 写进这条消息。四类卡片的定位与写入规则完全一致，收敛到本类避免各决策方各写一份遍历。</p>
 *
 * <p><b>定位规则</b>：主键（call id，即消息 id）命中优先；退化为按工具名取最后一条——
 * 兜底的是「快照反序列化后 id 缺失」的历史数据。两者都未命中返回 {@code null}，
 * 由调用方决定抛错还是降级（不同决策方的失败语义不同）。</p>
 *
 * <p>public 但仅限 toolcall 模块内使用：应用侧决策（{@code ToolCallServiceImpl} /
 * {@code CommandApprovalExecutor}）与基础设施侧回填（{@code DelegationSettleService}）共用。</p>
 */
public final class ExecutionToolSlot {

    private ExecutionToolSlot() {
    }

    /** 定位承载该调用的工具结果消息；未命中返回 {@code null}。 */
    public static ToolMessageEntity locate(Execution execution, String toolCallId, String toolName) {
        List<Message> messages = execution.getMessages();
        if (messages == null) {
            return null;
        }
        for (int i = messages.size() - 1; i >= 0; i--) {
            Message message = messages.get(i);
            if (message instanceof ToolMessageEntity tool && toolCallId.equals(String.valueOf(tool.getId()))) {
                return tool;
            }
        }
        if (toolName == null) {
            return null;
        }
        for (int i = messages.size() - 1; i >= 0; i--) {
            Message message = messages.get(i);
            if (message instanceof ToolMessageEntity tool && toolName.equals(tool.getName())) {
                return tool;
            }
        }
        return null;
    }

    /** 把回填文本写入槽位；未命中返回 {@code false}，失败语义由调用方决定。 */
    public static boolean write(Execution execution, String toolCallId, String toolName, String text) {
        ToolMessageEntity slot = locate(execution, toolCallId, toolName);
        if (slot == null) {
            return false;
        }
        slot.setText(text);
        return true;
    }

    /** 旧审批快照不含有效 requestIndex，恢复事件从原模型列表读取位置。 */
    public static int resolveRequestIndex(Execution execution, String toolCallId) {
        List<Message> messages = execution.getMessages();
        if (messages != null) {
            for (int i = messages.size() - 1; i >= 0; i--) {
                if (!(messages.get(i) instanceof AiMessageEntity ai) || ai.getToolCalls() == null) continue;
                List<ToolCallRequest> requests = ai.getToolCalls();
                for (int index = 0; index < requests.size(); index++) {
                    ToolCallRequest request = requests.get(index);
                    if (request != null && toolCallId.equals(request.id())) return index;
                }
            }
        }
        throw new ClientException("找不到原模型的工具请求，不能恢复审批事件");
    }
}
