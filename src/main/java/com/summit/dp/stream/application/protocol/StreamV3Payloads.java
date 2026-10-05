package com.summit.dp.stream.application.protocol;

import com.summit.dp.shared.vo.ModelToolCallVO;

import java.util.List;

/**
 * v3 事件载荷 DTO 集合。
 *
 * <p>全部为不可变 record：发布端只构造、不修改；一次发布序列化一次，广播给各连接共享。
 * 字段命名与前端 ingress 约定一致，禁止在发布端用 {@code Map.put} 临时拼装。</p>
 */
public final class StreamV3Payloads {

    private StreamV3Payloads() {
    }

    /** STREAM_READY：连接登记完成，携带本连接 ID 与连接代次，无业务状态。 */
    public record Ready(String connectionId, int schemaVersion) {
    }

    /** RESPONSE_STARTED：声明本次响应的起点身份。 */
    public record ResponseStarted(String streamKey, String purpose) {
    }

    /** 正文 / 思考增量：只追加片段。 */
    public record Delta(String streamKey, String delta) {
    }

    /** RESPONSE_FINALIZED：该响应的权威完整正文、思考与用途。 */
    public record ResponseFinalized(String streamKey, String text, String thinking, String purpose) {
    }

    /**
     * MESSAGE_COMMITTED：同一 streamKey 已落库消息的身份。
     *
     * <p>{@code thinking} 与 {@code toolCalls} 是 AI 行的**本体字段**，不是可选装饰：
     * 实时通道不发 {@code TOOL_CALL_UPDATED}（工具事实只存在于落库行），若提交载荷不带它们，
     * 前端把活响应归一为「已提交」后就再也拿不到思考与工具痕迹 —— 表现为回答一完成，
     * 思考过程与全部工具调用凭空消失，只有刷新（走 bootstrap 读完整行）才回来。</p>
     *
     * <p>USER 行两个字段均为 null。</p>
     */
    public record MessageCommitted(String streamKey, String messageId, String sessionId, String turnId,
                                   String text, String thinking, List<ModelToolCallVO> toolCalls, String type) {
    }

    /**
     * HISTORY_INVALIDATED：新代际与作废范围。
     *
     * <p>{@code turnIds} / {@code executionIds} 是本次作废**点名删除**的范围（重发：目标轮次及其后）。
     * 它们是提交事实自带的集合，随帧直投 —— 不带上，前端只能整树清空旧历史，
     * 会把重发点之前仍然有效的轮次一起抹掉（回执只负责删、不负责还原）。</p>
     */
    public record HistoryInvalidated(String rootSessionId, String historyRevision,
                                     List<String> turnIds, List<String> executionIds) {
    }

    /**
     * EXECUTION_UPDATED：执行生命周期状态语义。
     *
     * <p>只承载框架事件名所示的状态，不含执行摘要 —— 摘要由 bootstrap 或实体提交事件提供。</p>
     */
    public record ExecutionState(String state) {
    }
}
