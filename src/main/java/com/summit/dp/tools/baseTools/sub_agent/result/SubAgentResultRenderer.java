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
 *
 * <p><b>「暂停」不等于「失败」：</b>{@link ExecutionState#SUSPENDED} 表示子代理抛出了待人工审批的
 * 请求、正等人处理，任务并未失败。把它渲染成失败会让指挥者判定委派失败并**把同一件事重做一遍**；
 * 而父级的工具结果一旦落库就不可撤回，所以这一层必须自己把三种非完成态区分开。</p>
 *
 * <p><b>挂起分支如今是防御路径</b>：委派挂起的主路径已在 {@code CallSubAgentTool} promise 化
 * （父执行以 DELEGATION 槽位同步挂起，子终态由回填监听器写入槽位文本）；本类只保留兜底渲染，
 * 覆盖 promise 路径意外未生效时的场景。</p>
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
        ExecutionState state = execution.getExecutionState();
        if (ExecutionState.COMPLETED.equals(state)) {
            return renderCompleted(execution);
        }
        // 挂起与取消都不是失败：必须早于错误信息分支，否则会被下面「未能执行成功」兜底吞掉。
        if (ExecutionState.SUSPENDED.equals(state)) {
            return renderSuspended(execution);
        }
        if (ExecutionState.CANCELLED.equals(state)) {
            return "子代理执行已被取消（用户已停止），无结果: " + resolveTask(execution);
        }
        String errorMessage = execution.getErrorMessage();
        if (errorMessage != null && !errorMessage.isBlank()) {
            return errorMessage;
        }
        return "agent的任务未能执行成功: " + resolveTask(execution);
    }

    /**
     * 挂起态（等人工审批）的文案：明确「不是失败」+ 明确「不要重做」。
     *
     * <p>同时如实说明本次调用不会带回最终结果 —— 审批通过后子代理是在**它自己的执行**里继续跑，
     * 父级这条工具结果已经定稿，不能给出「稍后会收到结果」的虚假承诺。</p>
     */
    private String renderSuspended(Execution execution) {
        return "子代理已暂停，正在等待人工审批，任务尚未完成（不是失败）: " + resolveTask(execution)
                + "。审批处理完后它会自行继续，但本次调用不会返回它的最终结果 —— 请勿重复执行同一任务。";
    }

    /**
     * 失败兜底用的任务原文。
     *
     * <p>{@code agentRequest} 在「快照反序列化不全」或「框架内部构造的执行」上可能为 null，
     * 因此必须显式判空 —— 用 {@code Objects.toString(error, "..." + request.getTask())} 这种写法，
     * 兜底串会被<b>提前求值</b>，即使 error 非空也照样 NPE，把「有错误信息」这条正常路径一起炸掉。</p>
     */
    private String resolveTask(Execution execution) {
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
