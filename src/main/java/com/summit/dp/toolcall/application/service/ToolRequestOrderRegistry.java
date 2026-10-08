package com.summit.dp.toolcall.application.service;

import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 登记「本轮模型请求的工具顺序」：{@code (executionId, responseId, toolCallId) → 请求序号}。
 *
 * <p><b>为什么需要它</b>：工具块的展示顺序必须是<b>模型请求顺序</b>，而不是完成顺序 ——
 * 完成顺序受并发调度影响（{@code SERIAL_MUTATION}/{@code READ_ONLY} 混批时尤其明显），
 * 无法还原模型原本的意图。而工具开始事件（{@code ToolCallStartEvent}）到达业务侧时
 * 只带 {@code toolCallId}，不带请求序号；请求序号只存在于该轮 {@code AiMessageEntity.toolCalls}
 * 里。因此在「模型刚返回、尚未执行任何工具」的那个时点把顺序登记下来，供后续实时装配读取。</p>
 *
 * <p><b>为什么按 {@code responseId} 归档而不是按执行 id 单层归档</b>：一轮里可以发生多次模型调用，
 * 每次调用都有自己的工具请求列表。{@code responseId} 是框架为每次模型调用生成的唯一身份，
 * 天然一调用一档。外层再按 {@code executionId} 分桶，是为了让「执行结束一次性清档」既精确又廉价 ——
 * 不必在收尾时反过来遍历全部 responseId 归档找出属于本执行的那些。</p>
 *
 * <p><b>为什么不是权威落库来源</b>：历史顺序从 AI 行的 {@code toolCalls} 反解即可，
 * 不依赖本登记表。本表只服务「实时装配发生在该轮落库之前」的窗口，
 * 取不到时装配侧一律回退到「按 toolCallId 稳定排序」，绝不猜一个序号。</p>
 *
 * <p><b>并发与清理</b>：生产代码不持 static 可变字段，本类是单例 Bean；
 * 执行结束（{@code onRunEnd}）按执行 id 整体清档，避免长期运行的进程里累积。
 * 取档缺失返回 {@code null}（未知），不返回 0 冒充「第一个」。</p>
 */
@Component
public class ToolRequestOrderRegistry {

    /** executionId → （responseId → 工具请求顺序）。 */
    private final Map<String, Map<UUID, Map<String, Integer>>> ordersByExecution = new ConcurrentHashMap<>();

    /**
     * 登记一次模型调用的工具请求顺序。
     *
     * <p>顺序即 {@code toolCalls} 列表下标 —— 这就是模型下发的顺序，不做任何重排。
     * {@code executionId}/{@code responseId}/列表任一缺失时静默跳过：登记是观测行为，
     * 不能拖垮主执行流。</p>
     */
    public void register(String executionId, UUID responseId, AiMessageEntity aiMessage) {
        if (executionId == null || executionId.isBlank() || responseId == null || aiMessage == null) {
            return;
        }
        List<ToolCallRequest> toolCalls = aiMessage.getToolCalls();
        if (toolCalls == null || toolCalls.isEmpty()) {
            return;
        }
        Map<String, Integer> orders = new HashMap<>();
        for (int index = 0; index < toolCalls.size(); index++) {
            ToolCallRequest request = toolCalls.get(index);
            if (request != null && request.id() != null && !request.id().isBlank()) {
                orders.putIfAbsent(request.id(), index);
            }
        }
        if (orders.isEmpty()) {
            return;
        }
        ordersByExecution
                .computeIfAbsent(executionId, ignored -> new ConcurrentHashMap<>())
                .put(responseId, Map.copyOf(orders));
    }

    /**
     * 取某个工具调用在本轮模型请求里的顺序号。
     *
     * @return 0 基序号；未登记返回 {@code null}（表示「未知」，调用方据此回退排序，不得当成 0）
     */
    public Integer findOrder(String executionId, UUID responseId, String toolCallId) {
        if (executionId == null || responseId == null || toolCallId == null) {
            return null;
        }
        Map<UUID, Map<String, Integer>> byResponse = ordersByExecution.get(executionId);
        if (byResponse == null) {
            return null;
        }
        Map<String, Integer> orders = byResponse.get(responseId);
        return orders == null ? null : orders.get(toolCallId);
    }

    /**
     * 摘掉某次模型调用的登记；工具链收尾后调用，避免登记表随轮次增长。
     *
     * <p>只摘 {@code responseId} 那一档，不动同执行里的其它模型调用 —— 一次执行可能反复
     * 调用模型（每轮一次），逐档清理不会误伤。</p>
     */
    public void clear(String executionId, UUID responseId) {
        if (executionId == null || responseId == null) {
            return;
        }
        ordersByExecution.computeIfPresent(executionId, (key, byResponse) -> {
            byResponse.remove(responseId);
            return byResponse.isEmpty() ? null : byResponse;
        });
    }

    /** 执行结束整体清档：本执行名下所有模型调用的顺序登记一次性摘除。 */
    public void clearExecution(String executionId) {
        if (executionId == null || executionId.isBlank()) {
            return;
        }
        ordersByExecution.remove(executionId);
    }

    /** 当前在册执行档数，用于可观测性与测试断言。 */
    public int executionCount() {
        return ordersByExecution.size();
    }
}
