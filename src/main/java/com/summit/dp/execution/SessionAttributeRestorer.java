package com.summit.dp.execution;

import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

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
 * <p><b>权威来源</b>：会话行的 {@code team_id} 是团队绑定的唯一真源（可经
 * {@code /session/{id}/team} 换绑），故以库中记录覆盖快照值 —— 这同时保证「换绑后恢复」
 * 按新团队编排，与 {@code RequestPreparer} 的「已有会话一律以库中记录为准」同一口径。
 * 会话本身没有团队（单 Agent / 裸模型）时<b>必须移除</b>快照里的 {@code TEAM_ID}：
 * 解绑后若沿用旧值，恢复出来的执行仍会按已解绑的团队去委派。补回的属性会随恢复过程的
 * 检查点落库，快照因此自愈。</p>
 *
 * <p><b>子会话回落根会话（10-01）</b>：委派落库的子会话行不写 {@code teamId}
 * （{@code SubSessionResolver.createSubSession} 不带该列），它自身不承载团队绑定；
 * 但子执行的快照<b>有</b> {@code TEAM_ID}（随委派下行，恢复后二次委派 / 发邮件都依赖）。
 * 若把「子会话行 teamId 为 null」当成「已解绑」去移除，审批恢复就会把子执行的业务身份
 * 抹掉且随检查点自固化 —— 所以子会话一律沿 root 链上溯，以根会话的绑定为权威。</p>
 */
@Component
@RequiredArgsConstructor
public class SessionAttributeRestorer {

    private final SessionRepository sessionRepository;

    /**
     * 用会话生效的团队绑定覆盖执行请求上的 {@link ExecutionAttributes#TEAM_ID}。
     *
     * @param execution 即将交给 loop 恢复的执行实例（会被原地修改）
     * @param sessionId 该执行所属会话（可能是子会话）
     * @return 是否真的改动了属性；会话或执行请求缺失时返回 {@code false}
     */
    public boolean restore(Execution execution, Long sessionId) {
        if (execution == null || sessionId == null) {
            return false;
        }
        Session session = sessionRepository.findById(sessionId).orElse(null);
        if (session == null) {
            return false;
        }
        AgentRuntimeParameters parameters = execution.getAgentRequest().runtimeParametersOrDefault();
        Map<String, Object> attributes = new HashMap<>(parameters.getAttributes());
        Long teamId = effectiveTeamIdOf(session);
        if (teamId == null) {
            // 会话已解绑（或本就非团队）：清掉快照里的陈旧团队身份，避免「解绑后恢复仍按旧队委派」。
            if (attributes.remove(ExecutionAttributes.TEAM_ID) == null) {
                return false;
            }
        } else {
            attributes.put(ExecutionAttributes.TEAM_ID, teamId.toString());
        }
        parameters.setAttributes(Map.copyOf(attributes));
        return true;
    }

    /**
     * 会话生效的团队绑定权威：自身有绑定用自身的；否则子会话沿 root 链上溯，
     * 取最近一个带绑定的祖先（祖父级委派产生的孙会话同样覆盖）。链断或全链无绑定返回 null。
     *
     * <p>{@code visited} 只防脏数据成环时死循环，正常树上不会命中。</p>
     */
    private Long effectiveTeamIdOf(Session session) {
        if (session.getTeamId() != null) {
            return session.getTeamId();
        }
        Session current = session;
        Set<Long> visited = new HashSet<>();
        while (current.isSubSession() && visited.add(current.getId())) {
            current = sessionRepository.findById(current.getRootSessionId()).orElse(null);
            if (current == null) {
                return null;
            }
            if (current.getTeamId() != null) {
                return current.getTeamId();
            }
        }
        return null;
    }
}
