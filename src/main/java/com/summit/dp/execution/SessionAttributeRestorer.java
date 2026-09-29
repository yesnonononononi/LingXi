package com.summit.dp.execution;

import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.Map;

/**
 * 恢复执行前，把<b>会话级业务属性</b>补回执行请求（目前是 {@link ExecutionAttributes#TEAM_ID}）。
 *
 * <p><b>为什么恢复需要单独补</b>：新建执行走 {@code RequestPreparer}，会话级属性（团队绑定）
 * 会随请求一起写进 {@code AgentRequest.attributes} 并落进执行快照；而<b>恢复不经过 prepare</b>——
 * 三条恢复入口（{@code ChatServiceImpl#resume}、{@code ToolCallServiceImpl#decideDecision}、
 * {@code CommandApprovalExecutor#finish}）都是直接读快照后交给 loop。快照一旦缺少该属性，
 * 恢复后的委派工具就解析不到团队，直接返回「未确定当前协作团队，无法委派任务」——
 * 表现为「挂起前能委派、恢复后子 Agent 起不来」。</p>
 *
 * <p>缺少属性的快照在现实中确实存在：团队绑定曾经通过 ThreadLocal 传播，属性化是后加的，
 * 因此升级前写入的检查点天然没有 {@code lingxi.team_id}。</p>
 *
 * <p><b>权威来源</b>：会话行的 {@code team_id} 在会话创建后不可变，故以库中记录覆盖快照值，
 * 与 {@code RequestPreparer} 的「已有会话一律以库中记录为准、忽略请求值」保持同一口径。
 * 会话本身没有团队（单 Agent / 裸模型）时不写入，不凭空制造团队身份。补回的属性会随恢复过程的
 * 检查点落库，快照因此自愈。</p>
 */
@Component
@RequiredArgsConstructor
public class SessionAttributeRestorer {

    private final SessionRepository sessionRepository;

    /**
     * 补齐执行请求上的会话级业务属性。
     *
     * @param execution 即将交给 loop 恢复的执行实例（会被原地修改）
     * @param sessionId 该执行所属会话（可能是子会话）
     * @return 是否真的写入了属性；未写入（会话无团队 / 执行无请求）返回 {@code false}
     */
    public boolean restore(Execution execution, Long sessionId) {
        if (execution == null || sessionId == null || execution.getAgentRequest() == null) {
            return false;
        }
        Session session = sessionRepository.findById(sessionId).orElse(null);
        if (session == null || session.getTeamId() == null) {
            return false;
        }
        AgentRuntimeParameters parameters = execution.getAgentRequest().runtimeParametersOrDefault();
        Map<String, Object> attributes = new HashMap<>(parameters.getAttributes());
        attributes.put(ExecutionAttributes.TEAM_ID, session.getTeamId().toString());
        parameters.setAttributes(Map.copyOf(attributes));
        return true;
    }
}
