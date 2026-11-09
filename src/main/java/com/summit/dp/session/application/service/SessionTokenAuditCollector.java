package com.summit.dp.session.application.service;

import com.summit.core.audit.token.TokenAuditDocument;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.session.application.convert.TokenAuditConverter;
import com.summit.dp.session.application.convert.TokenAuditFrameworkViewConverter;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionTokenAudit;
import com.summit.dp.session.domain.model.TokenAuditPersistedState;
import com.summit.dp.session.domain.model.TokenAuditReconciler;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.domain.repo.SessionTokenAuditRepository;
import com.summit.dp.session.application.port.TokenAuditBroadcaster;
import com.summit.dp.shared.vo.SessionTokenAuditVO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;

/**
 * 会话级 token 审计采集：落库 + 广播。**纯服务，不是 {@code RuntimeListener}。**
 *
 * <p><b>为什么不自己订阅框架事件</b>：{@code com.summit.dp.workflow} 正在把原先 6 个各自为战、
 * 靠 {@code @Order} 抢顺序的 listener 收敛成单一的 {@code ExecutionLifecycleProjectionListener}。
 * 再加第七个 listener 就是与重构对着干，且 {@code AgentEventListener} 此刻挂在别人的未提交改动里，
 * 碰它必在合并时炸。因此本类只提供「可被统一 listener 直接调用的能力」，
 * {@link #collect} / {@link #markFailed} 由接线方在合适的时机调用。</p>
 *
 * <p><b>归属解析不另起口径</b>：执行标识 → 会话 → 根会话一律走 {@link ExecutionLocator}
 * （{@code sessionId} / {@code resolveRootSessionId}）与 {@link ExecutionEventMetadata}
 * （键 {@code sessionId} / {@code rootSessionId}，十进制字符串），与 {@code AgentEventListener.resolveTarget}
 * 同源同口径。元数据优先、定位器兜底：前者零查询且不会因执行行被清理而丢失归属，
 * 后者覆盖「元数据缺失的历史检查点」。重构后这套解析若被抽成公共组件，本类的两个私有解析方法是
 * 唯一替换点。</p>
 *
 * <p><b>为什么广播不在事务里</b>：落库走仓储方法自身的独立事务，提交返回后才广播。
 * 反过来（事务内广播）会把还没提交的数据先推给前端，一旦回滚，用户看到的就是一份不存在的快照。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SessionTokenAuditCollector {

    /** 失败原因里「类型: 消息」的分隔符；总长由领域层截断到 {@link SessionTokenAudit#MAX_FAIL_REASON_LENGTH}。 */
    private static final String FAIL_REASON_SEPARATOR = ": ";

    private final SessionTokenAuditRepository auditRepository;
    private final SessionRepository sessionRepository;
    private final ExecutionLocator executionLocator;
    private final TokenAuditConverter converter;
    private final SessionTokenAuditQueryService queryService;
    /**
     * 实时推送端口（软依赖）：容器里有实现就推，没有就跳过。
     *
     * <p><b>为什么用 {@code ObjectProvider} 而不是直接注入</b>：实现位于工作流模块
     * （SSE 投递属于工作流职责，业务模块不许依赖它，见 {@code WorkflowDependencyTest}）。
     * 用软依赖可以让「采集 + 落库 + 查 API」在没有任何推送实现时照常工作，
     * 缺的只是实时性 —— 前端下次 GET 拿到的仍是同一份数据。</p>
     */
    private final ObjectProvider<TokenAuditBroadcaster> broadcasters;

    /**
     * 采集一次成功的审计结果：换算 → 覆盖裁决 → 落库 → 广播。
     *
     * <p>调用时机见类注释；本方法自身不校验「现在是不是终态」，那是接线方的职责。</p>
     *
     * @param executionId   产出审计结果的执行标识；可为 {@code null}（此时只能靠元数据解析归属）
     * @param document      框架审计文档；{@code null} 视为全 0 的空采集
     * @param eventMetaData 框架事件携带的业务归属元数据，可为 {@code null}
     * @param capturedAt    框架采集时刻，用于判别同一执行的迟到结果
     */
    public void collect(String executionId, TokenAuditDocument document,
                        Map<String, Object> eventMetaData, Instant capturedAt) {
        Long sessionId = resolveSessionId(executionId, eventMetaData);
        if (sessionId == null) {
            log.warn("丢弃无法定位会话的 token 审计结果: executionId={}", executionId);
            return;
        }
        Session session = sessionRepository.findById(sessionId).orElse(null);
        TokenAuditReconciler.Result result =
                TokenAuditReconciler.reconcile(converter.toMeasurement(document, session));
        SessionTokenAudit incoming = SessionTokenAudit.capture(sessionId, numericExecutionId(executionId),
                result, capturedAt);
        incoming.changeFrameworkDocument(TokenAuditFrameworkViewConverter.write(document));

        // 乱序投递（同一执行重复到达 / 更早的执行迟到）不得覆盖更新的快照。
        if (!auditRepository.replaceSnapshot(incoming)) {
            log.debug("跳过过期采集: sessionId={}, executionId={}", sessionId, executionId);
            return;
        }
        broadcast(resolveRootSessionId(sessionId, eventMetaData), sessionId);
    }

    /**
     * 采集失败：按「不得覆盖已有成功快照」的硬规则落库，并广播最新真实状态。
     *
     * <p><b>规则（硬性）</b>：</p>
     * <ul>
     *   <li>当前无快照 → 落 {@code FAILED}，{@code fail_reason} = {@code errorType + ": " + errorMessage}，
     *       总长由领域层截断到 512 字符（按<b>字符</b>计，不会截出半个汉字）。</li>
     *   <li>已有 {@code COLLECTED} → <b>保留快照不动</b>，只把「最近一次失败」记为告警日志。
     *       一次偶发失败不能把上一份可用数据踩成失败态。</li>
     * </ul>
     *
     * @param executionId  失败所在执行标识；可为 {@code null}
     * @param errorType    框架给出的错误类型，可为 {@code null}
     * @param errorMessage 框架给出的错误消息，可为 {@code null}
     * @param eventMetaData 框架事件携带的业务归属元数据，可为 {@code null}
     */
    public void markFailed(String executionId, String errorType, String errorMessage,
                           Map<String, Object> eventMetaData) {
        Long sessionId = resolveSessionId(executionId, eventMetaData);
        if (sessionId == null) {
            log.warn("丢弃无法定位会话的 token 审计失败事件: executionId={}, errorType={}",
                    executionId, errorType);
            return;
        }
        String reason = composeFailReason(errorType, errorMessage);
        Optional<SessionTokenAudit> existing = auditRepository.findBySessionId(sessionId);
        if (existing.isPresent()
                && existing.get().getState() == TokenAuditPersistedState.COLLECTED) {
            log.warn("保留已有 COLLECTED 快照，仅记录最近一次失败: sessionId={}, executionId={}, reason={}",
                    sessionId, executionId, reason);
            return;
        }
        auditRepository.markFailed(sessionId, numericExecutionId(executionId), reason);
        broadcast(resolveRootSessionId(sessionId, eventMetaData), sessionId);
    }

    /**
     * 广播最新快照（失败也不抛出：采集已落库，广播只是实时性优化）。
     *
     * @param rootSessionId 路由用根会话；为 {@code null} 时跳过
     * @param sessionId     快照所属会话
     */
    private void broadcast(Long rootSessionId, Long sessionId) {
        if (rootSessionId == null || sessionId == null) {
            return;
        }
        try {
            SessionTokenAuditVO payload = queryService.snapshot(sessionId);
            broadcasters.ifAvailable(broadcaster -> broadcaster.publishSnapshot(rootSessionId, payload));
        } catch (RuntimeException e) {
            // 广播失败不能影响采集结果：数据已落库，前端下次 GET 仍能拿到。
            log.warn("token 审计广播失败，已忽略: sessionId={}, error={}", sessionId, e.getMessage());
        }
    }

    /**
     * 解析快照归属会话：元数据优先，{@link ExecutionLocator} 兜底。
     *
     * @return 会话标识；两条路都拿不到时返回 {@code null}
     */
    private Long resolveSessionId(String executionId, Map<String, Object> eventMetaData) {
        Long fromMetadata = ExecutionEventMetadata.sessionId(eventMetaData);
        if (fromMetadata != null) {
            return fromMetadata;
        }
        if (executionId == null || executionId.isBlank()) {
            return null;
        }
        try {
            return executionLocator.sessionId(executionId);
        } catch (IllegalStateException | NumberFormatException e) {
            log.warn("无法由执行标识定位会话: executionId={}, reason={}", executionId, e.getMessage());
            return null;
        }
    }

    /**
     * 解析广播路由用的根会话：元数据优先，定位器兜底，最终退化为会话自身。
     *
     * <p>退化为自身而不返回 {@code null}：子会话查不到根时仍应推给自己的订阅者，
     * 丢掉广播会让侧边栏停在旧数字上。</p>
     */
    private Long resolveRootSessionId(Long sessionId, Map<String, Object> eventMetaData) {
        Long fromMetadata = ExecutionEventMetadata.parseRootSessionId(eventMetaData);
        if (fromMetadata != null) {
            return fromMetadata;
        }
        if (sessionId == null) {
            return null;
        }
        try {
            return executionLocator.resolveRootSessionId(sessionId);
        } catch (IllegalStateException e) {
            log.warn("无法定位根会话，退化为会话自身: sessionId={}, reason={}", sessionId, e.getMessage());
            return sessionId;
        }
    }

    /** 执行标识在库里是 BIGINT 自增；非数字（理论上不会出现）按「未知执行」落 null。 */
    private static Long numericExecutionId(String executionId) {
        if (executionId == null || executionId.isBlank()) {
            return null;
        }
        try {
            return Long.parseLong(executionId.strip());
        } catch (NumberFormatException e) {
            log.warn("执行标识不是数字，快照按未知执行落库: executionId={}", executionId);
            return null;
        }
    }

    /** 失败原因拼装；空值兜底与长度截断都交给领域层，避免两处规则漂移。 */
    private static String composeFailReason(String errorType, String errorMessage) {
        String type = errorType == null ? "" : errorType.strip();
        String message = errorMessage == null ? "" : errorMessage.strip();
        if (type.isEmpty()) {
            return message;
        }
        return message.isEmpty() ? type : type + FAIL_REASON_SEPARATOR + message;
    }
}
