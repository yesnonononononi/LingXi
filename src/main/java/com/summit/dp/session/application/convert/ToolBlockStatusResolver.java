package com.summit.dp.session.application.convert;

import com.summit.dp.shared.vo.block.BlockStatus;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 工具块状态的**唯一映射点**：{@code tool_call} 行 → {@link BlockStatus}。
 *
 * <p><b>为什么必须集中在一处</b>：{@code tool_call.status} 只表达生命周期
 * （preparing/pending/in_progress/completed），<b>{@code completed} 不等于成功</b> ——
 * 成功、被拒、取消、超时的结论在 {@code raw_output.outcome}。若渲染层各自解读这两列，
 * 就会出现「工具失败却显示绿色对勾」这类不一致。映射只在后端做一次，前端只读结果。</p>
 *
 * <p><b>两列怎么合起来读</b>：</p>
 * <ol>
 *   <li>{@code completed} 且有 outcome → 直接采用 outcome（成功/被拒/失败/超时/取消）；</li>
 *   <li>{@code in_progress} → {@link BlockStatus#TOOL_STARTED}（正在跑，尚无结论）；</li>
 *   <li>{@code pending}/{@code preparing}（PROMISE 未决）→ {@link BlockStatus#TOOL_PROMISED}
 *       （等待人工决策，不是「已开始」也不是「已完成」）。</li>
 * </ol>
 *
 * <p><b>结论读取复用 {@link ToolCallConverter#readOutcome}</b>：outcome 的读侧解析只应有一处
 * （写读同源），本类不另写一套 JSON 解析 —— 那样一改键名就会静默读到 {@code null}。</p>
 */
@Component
@RequiredArgsConstructor
public class ToolBlockStatusResolver {

    private final ToolCallConverter toolCallConverter;

    /**
     * 解析工具块展示状态。
     *
     * @return 恒定非 {@code null}：无法识别时回退 {@link BlockStatus#TOOL_FAILED}
     *         （宁可显示为失败，也不假装成功）
     */
    public String resolve(ToolCall toolCall) {
        if (toolCall == null || toolCall.getStatus() == null) {
            return BlockStatus.TOOL_FAILED;
        }
        ToolCallStatus lifecycle = toolCall.getStatus();
        if (lifecycle == ToolCallStatus.COMPLETED) {
            return resolveFromOutcome(toolCallConverter.readOutcome(toolCall));
        }
        if (lifecycle == ToolCallStatus.IN_PROGRESS) {
            return BlockStatus.TOOL_STARTED;
        }
        // preparing / pending：PROMISE 未决槽位
        return BlockStatus.TOOL_PROMISED;
    }

    /** 结论 → 展示状态；缺失结论时按失败处理（不假装成功）。 */
    private static String resolveFromOutcome(ToolCallOutcome outcome) {
        if (outcome == null) {
            return BlockStatus.TOOL_FAILED;
        }
        return switch (outcome) {
            case SUCCEEDED, APPROVED, ANSWERED -> BlockStatus.TOOL_COMPLETED;
            case REJECTED -> BlockStatus.TOOL_REJECTED;
            case CANCELLED -> BlockStatus.TOOL_CANCELLED;
            case TIMED_OUT -> BlockStatus.TOOL_TIMED_OUT;
            case FAILED -> BlockStatus.TOOL_FAILED;
        };
    }
}
