package com.summit.dp.workflow.application.compact;

import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextCompactRequest;
import com.summit.core.compact.ContextCompacter;
import com.summit.core.compact.ContextUsageMetric;
import com.summit.core.runtime.loop.ContextUsageReporter;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionTokenAuditQueryService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.ContextCompactionVO;
import com.summit.runtime.audit.ExecutionTokenAuditRecorder;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;

/**
 * 手工压缩会话上下文（输入栏 {@code /compact}）。
 *
 * <p><b>为什么需要它</b>：框架的压缩只有两条触发路径 —— 上下文占比越过阈值时由
 * {@code BoundaryChecker} 自动触发，或模型自己决定调用 {@code compact_context} 工具。
 * 用户想「我现在就压一次」时两者都按不到，只能干等阈值。本类是那个按钮的执行体。</p>
 *
 * <p><b>压缩为什么直接调 {@link ContextCompacter}，而不是跑一个只有压缩的回合</b>：
 * 压缩是纯上下文变换，不需要模型再产生一轮回答；跑回合会多一次模型调用、多一条助手消息，
 * 还要额外定义「这轮没有用户输入」的历史形态。框架把这个 SPI 的「何时做」刻意留给调用方
 * （{@code ContextCompactRequest.decision} 允许为空），就是为这类手工入口准备的。</p>
 *
 * <p><b>为什么压缩完还要手动刷用量与审计</b>：正常路径里它们是运行时的副作用 ——
 * 用量由 {@code SessionContextUsageProjector} 在执行收口时落库，审计由终态事件驱动。
 * 手工压缩没有执行收口，两件事都没人做；不补的话，回执里的「最新用量」会是压缩前那份，
 * 审计面板也停在压缩前，用户只会看到「压缩成功」却量不出任何变化。</p>
 *
 * <p><b>不消耗摘要尝试预算</b>：刻意绕过 {@code BoundaryChecker}，因此
 * {@code CompactionState.summaryAttempts} 不变、也不会置 {@code summaryUnavailable}。
 * 用户主动要求 ≠ 自动救火，把自动路径的失败预算算到手工路径上只会让后者莫名其妙被卡死。</p>
 */
@Slf4j
@Service
public class ContextCompactionService {

    /**
     * 手工压缩的最低用量门槛：占比不超过这个值时直接拒绝。
     *
     * <p>压缩要花一次真实模型调用并把上下文重建成摘要 —— 上下文还很空时做这件事，
     * 既浪费钱又<b>主动打断前缀缓存</b>（重建后的前缀必然全部未命中），净收益为负。</p>
     */
    static final double MIN_USAGE_RATIO = 0.20d;

    /** 找最近执行时的候选窗口：状态可能混杂终态与挂起，取一小批足够覆盖。 */
    private static final int RECENT_EXECUTION_WINDOW = 5;

    /** 业务执行行（库表投影）。与框架同名接口只能写全名区分。 */
    private final com.summit.dp.execution.domain.repository.ExecutionRepository executionRows;
    /** 框架执行快照（含消息正文的检查点文件）。 */
    private final com.summit.core.runtime.loop.ExecutionRepository executionSnapshots;
    private final ContextCompacter modelCompacter;
    private final ContextUsageReporter usageReporter;
    private final ModelContextService modelContextService;
    private final SessionAggregateService sessionService;
    private final SessionTokenAuditQueryService auditQueryService;
    private final ObjectProvider<ExecutionTokenAuditRecorder> auditRecorder;

    public ContextCompactionService(
            com.summit.dp.execution.domain.repository.ExecutionRepository executionRows,
            com.summit.core.runtime.loop.ExecutionRepository executionSnapshots,
            @Qualifier("modelCompacter") ContextCompacter modelCompacter,
            ContextUsageReporter usageReporter,
            ModelContextService modelContextService,
            SessionAggregateService sessionService,
            SessionTokenAuditQueryService auditQueryService,
            ObjectProvider<ExecutionTokenAuditRecorder> auditRecorder) {
        this.executionRows = executionRows;
        this.executionSnapshots = executionSnapshots;
        this.modelCompacter = modelCompacter;
        this.usageReporter = usageReporter;
        this.modelContextService = modelContextService;
        this.sessionService = sessionService;
        this.auditQueryService = auditQueryService;
        this.auditRecorder = auditRecorder;
    }

    /**
     * 压缩一个空闲会话的上下文，并回执压缩后的用量与重算的审计。
     *
     * @param sessionId 目标会话；其最近一次终态执行提供待压缩的上下文
     * @param body      命令正文。{@code /compact} 不接受正文，非空白一律拒绝
     * @return 压缩结果；上下文未改写时 {@code audit} 为 null
     * @throws ClientException 正文非空、会话仍在执行、无可用执行快照、用量不足或未配上下文窗口
     */
    public ContextCompactionVO compact(long sessionId, String body) {
        rejectBody(body);
        rejectRunning(sessionId);

        Execution execution = loadLatestTerminalExecution(sessionId);

        ContextUsageMetric before = usageReporter.report(execution);
        if (before == null) {
            throw new ClientException("当前模型未配置上下文窗口，无法评估用量，压缩已取消");
        }
        rejectLowUsage(before);

        boolean compacted = modelCompacter.compact(new ContextCompactRequest(execution));
        if (!compacted) {
            log.info("[manual-compact] 压缩未产出可用摘要，上下文保持不变: sessionId={}, executionId={}",
                    sessionId, execution.getId());
            return ContextCompactionVO.builder()
                    .compacted(false)
                    .tokensBefore(before.tokenCount())
                    .auditRefreshed(false)
                    .message("压缩未产出可用摘要，上下文保持不变")
                    .build();
        }

        // 先写回上下文再刷用量：后面的审计落库会重新读会话行取「实时用量」，
        // 顺序反了落进去的仍是压缩前的值，且不会报错 —— 只会安静地骗人。
        modelContextService.replace(sessionId, execution.getMessages());
        ContextUsageMetric after = usageReporter.report(execution);
        execution.setContextUsageMetric(after);
        saveUsage(sessionId, after);

        boolean auditRefreshed = refreshAudit(execution);

        return ContextCompactionVO.builder()
                .compacted(true)
                .tokensBefore(before.tokenCount())
                .tokensAfter(after == null ? null : after.tokenCount())
                .auditRefreshed(auditRefreshed)
                .message(auditRefreshed ? "上下文已压缩" : "上下文已压缩，但审计未能刷新")
                .audit(auditQueryService.snapshot(sessionId))
                .build();
    }

    /** {@code /compact} 是纯命令：带正文说明用户误解了它的用法，静默忽略等于吞掉他写的内容。 */
    private static void rejectBody(String body) {
        if (body != null && !body.isBlank()) {
            throw new ClientException("/compact 不接受正文，请直接发送 /compact");
        }
    }

    /**
     * 拒绝仍在执行的会话。
     *
     * <p>压缩改的是执行内存里的消息集合，与正在跑的 loop 抢同一份上下文会互相覆盖；
     * 而且运行中每轮结束本来就会被自动压缩接管，手工插一脚没有意义。</p>
     */
    private void rejectRunning(long sessionId) {
        if (!executionRows.findUnfinishedBySessions(List.of(sessionId)).isEmpty()) {
            throw new ClientException("会话正在执行中，请等待本轮结束或停止后再压缩上下文");
        }
    }

    /**
     * 取最近一次终态执行并还原它的检查点快照。
     *
     * <p>只有终态执行可压缩：框架审计器对非终态执行直接跳过，而且非终态执行的上下文
     * 仍属于「还未定稿」的一轮，压缩它等于替运行中的 loop 改历史。</p>
     */
    private Execution loadLatestTerminalExecution(long sessionId) {
        Optional<Long> latest = executionRows.findRecentBySession(sessionId, RECENT_EXECUTION_WINDOW).stream()
                .filter(row -> ExecutionStatusCodes.isTerminal(row.getStatus()))
                .map(com.summit.dp.execution.domain.model.Execution::getId)
                .max(Long::compareTo);
        if (latest.isEmpty()) {
            throw new ClientException("当前会话还没有可压缩的执行记录，先对话一轮吧");
        }
        return executionSnapshots.findById(String.valueOf(latest.get()))
                .orElseThrow(() -> new ClientException("执行快照不存在或已回收，无法压缩上下文"));
    }

    private static void rejectLowUsage(ContextUsageMetric before) {
        if (before.ratio() <= MIN_USAGE_RATIO) {
            throw new ClientException(String.format(
                    "当前上下文用量仅 %.1f%%，未超过 %.0f%%，无需压缩",
                    before.ratio() * 100, MIN_USAGE_RATIO * 100));
        }
    }

    /** 落库压缩后的用量：审计回执与用量环都按会话行的这一对数取「实时值」。 */
    private void saveUsage(long sessionId, ContextUsageMetric metric) {
        if (metric == null) {
            return;
        }
        sessionService.saveContextUsage(sessionId, (long) metric.tokenCount(), metric.maxTokens(), metric.ratio());
    }

    /**
     * 用压缩后的消息重算审计并落库广播。
     *
     * <p>走框架的 {@link ExecutionTokenAuditRecorder} 而不是自己算：它把「算 → 发事件 → 业务落库 →
     * 广播」整条链接好了，业务侧监听器据此覆盖快照（同执行、更新的采集时刻允许覆盖，
     * 仓储注释里就写明这是给「手动刷新」用的）。审计开关关闭时拿不到该 bean，
     * 此时明确回报「审计没刷新」，不假装成功。</p>
     *
     * @return 是否真的触发了重算（框架审计开关关闭时为 {@code false}）
     */
    private boolean refreshAudit(Execution execution) {
        ExecutionTokenAuditRecorder recorder = auditRecorder.getIfAvailable();
        if (recorder == null) {
            log.warn("[manual-compact] 框架 token 审计未启用（lingxi.agent.runtime.token-audit.enabled），"
                    + "手工压缩只刷新用量: executionId={}", execution.getId());
            return false;
        }
        recorder.record(execution);
        return true;
    }
}
