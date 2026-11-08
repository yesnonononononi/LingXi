package com.summit.dp.workflow.infrastructure.stream;

import com.summit.dp.session.application.port.TokenAuditBroadcaster;
import com.summit.dp.shared.vo.SessionTokenAuditVO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 审计快照的 SSE 投递实现（{@link TokenAuditBroadcaster} 的工作流侧实现）。
 *
 * <p><b>迁移标注（过渡接线）</b>：本类是<b>过渡接线</b>，待 workflow 统一
 * {@code ExecutionLifecycleProjectionListener} 落地后迁移 —— 届时推送时机由统一投影接管，
 * 本类应整体删除，只保留「端口 → {@code SseEventPublisher}」这条映射。</p>
 *
 * <p><b>为什么实现放在工作流模块</b>：{@code SseEventPublisher} 属于工作流，业务模块
 * （{@code com.summit.dp.session}）不许反向依赖它（见 {@code WorkflowDependencyTest}）。
 * 因此业务侧只声明 {@link TokenAuditBroadcaster} 端口并软依赖（{@code ObjectProvider}），
 * 由本类提供唯一实现；容器里没有本类时采集照常落库，只是少了实时性。</p>
 *
 * <p><b>为什么必须吞异常</b>：推送是<b>旁路观测</b>动作。审计结果此刻已经落库提交，
 * 推送失败只意味着用户要多等一次 GET，绝不该把一次成功的模型调用顶成错误 ——
 * 因此这里捕获 {@link RuntimeException} 并只记 warn。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class TokenAuditSseBroadcaster implements TokenAuditBroadcaster {

    private final SseEventPublisher sseEventPublisher;

    /**
     * 把一条快照推给订阅了该根会话的所有流。
     *
     * <p>事件名取 {@link TokenAuditBroadcaster#EVENT_NAME}，载荷与
     * {@code GET /session/{id}/token-audit} 的 {@code data} 同构，前端一套解析通吃。</p>
     *
     * @param rootSessionId 推送路由用的根会话；{@code null} 时跳过（没有路由就无从投递）
     * @param payload       快照视图；{@code null} 时跳过
     */
    @Override
    public void publishSnapshot(Long rootSessionId, SessionTokenAuditVO payload) {
        if (rootSessionId == null || payload == null) {
            return;
        }
        try {
            sseEventPublisher.publishBusiness(rootSessionId, TokenAuditBroadcaster.EVENT_NAME, payload);
        } catch (RuntimeException failure) {
            // 推送是旁路：失败只记录，不向调用方传播（采集结果已经落库）。
            log.warn("token 审计快照推送失败，已忽略: rootSessionId={}, error={}, message={}",
                    rootSessionId, failure.getClass().getSimpleName(), failure.getMessage());
        }
    }
}
