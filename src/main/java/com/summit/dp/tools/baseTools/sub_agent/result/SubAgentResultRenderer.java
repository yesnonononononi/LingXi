package com.summit.dp.tools.baseTools.sub_agent.result;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 把子执行结果渲染成返回给指挥者的文本。
 *
 * <p>只做「结果 → 文本」的翻译：成功时取最后一条 AI 消息的正文，失败时取错误信息。
 * 不在这里判断该不该委派、也不碰任何状态，因此可以脱离全部基础设施单独测试。</p>
 */
@Component
public class SubAgentResultRenderer {

    /**
     * 成功：优先取<b>最后一条</b> {@link AiMessageEntity} 的正文 —— 子 Agent 收尾往往
     * 不再追加消息，倒序取到的就是它的最终答复。没有 AI 消息时退化为末条消息的文本。
     * 失败：优先取执行自带的错误信息，缺失时用任务原文兜底，保证返回的永远是非空可读文本。
     */
    public String render(Execution execution) {
        if (execution == null) {
            return "agent的任务未能执行成功: 未返回执行结果";
        }
        if (ExecutionState.COMPLETED.equals(execution.getExecutionState())) {
            return renderCompleted(execution);
        }
        String errorMessage = execution.getErrorMessage();
        if (errorMessage != null && !errorMessage.isBlank()) {
            return errorMessage;
        }
        return "agent的任务未能执行成功: " + taskOf(execution);
    }

    /**
     * 失败兜底用的任务原文。
     *
     * <p>{@code agentRequest} 在「快照反序列化不全」或「框架内部构造的执行」上可能为 null，
     * 因此必须显式判空 —— 用 {@code Objects.toString(error, "..." + request.getTask())} 这种写法，
     * 兜底串会被<b>提前求值</b>，即使 error 非空也照样 NPE，把「有错误信息」这条正常路径一起炸掉。</p>
     */
    private String taskOf(Execution execution) {
        AgentRequest request = execution.getAgentRequest();
        if (request == null || request.getTask() == null) {
            return "未提供任务描述";
        }
        return String.valueOf(request.getTask());
    }

    private String renderCompleted(Execution execution) {
        List<Message> messages = execution.getMessages();
        if (messages == null || messages.isEmpty()) {
            return "agent已完成任务，但未返回文本结果";
        }
        for (int i = messages.size() - 1; i >= 0; i--) {
            if (messages.get(i) instanceof AiMessageEntity aiMessageEntity) {
                return aiMessageEntity.text();
            }
        }
        return messages.getLast().text();
    }
}
