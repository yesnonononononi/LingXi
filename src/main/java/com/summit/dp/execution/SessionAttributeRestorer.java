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
 * 恢复执行前，把<b>会话级业务属性</b>（{@link ExecutionAttributes#TEAM_ID}）与<b>执行事件归属身份</b>
 * （{@link ExecutionEventMetadata#ROOT_SESSION_ID} / {@link ExecutionEventMetadata#HISTORY_REVISION}）
 * 补回执行请求。
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
     * 恢复准备：补回会话级业务属性（团队绑定）与事件归属身份（根会话、历史代际）。
     *
     * <p>两类修复的理由不同，但<b>都只在恢复准备阶段做一次</b>：</p>
     * <ul>
     *   <li><b>团队绑定</b>：恢复不经过 {@code RequestPreparer}，会话级属性不会重新下发；</li>
     *   <li><b>根会话 / 历史代际</b>：旧检查点是在本次改造之前落库的，元数据里根本没有
     *       {@code rootSessionId}/{@code historyRevision} 两个键。补齐后随恢复的检查点自固化，
     *       后续事件不会再重复修复（§12 的明确口径）。</li>
     * </ul>
     *
     * <p>代际取<b>恢复时</b>的根会话代际：恢复读的是当前所有者会话，其代际即当下权威值。</p>
     *
     * @param execution 即将交给 loop 恢复的执行实例（会被原地修改）
     * @param sessionId 该执行所属会话（可能是子会话）
     * @return 是否真的改动了属性或元数据；会话或执行请求缺失时返回 {@code false}
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
        boolean attributesChanged = restoreTeamAttribute(parameters, session);
        boolean metadataChanged = repairEventMetadata(parameters, session);
        return attributesChanged || metadataChanged;
    }

    /** 用会话生效的团队绑定覆盖请求属性；是否改动见返回值。 */
    private boolean restoreTeamAttribute(AgentRuntimeParameters parameters, Session session) {
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
     * 补齐旧检查点缺失的根会话与历史代际；两者都已存在时不改动。
     *
     * <p>根会话沿 {@link Session#getRootSessionId()} 解析：子会话回指其根，根会话指向自身；
     * 子会话行缺根时回落为会话自身 id（与 {@code ExecutionContext.root} 同口径）。</p>
     */
    private boolean repairEventMetadata(AgentRuntimeParameters parameters, Session session) {
        Map<String, Object> metadata = parameters.getEventMetaData();
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(metadata);
        Long historyRevision = ExecutionEventMetadata.parseHistoryRevision(metadata);
        if (rootSessionId != null && historyRevision != null) {
            return false;
        }
        long resolvedRoot = rootSessionId != null
                ? rootSessionId
                : resolveRootSessionId(session);
        long resolvedRevision = historyRevision != null && historyRevision > 0L
                ? historyRevision
                : resolveHistoryRevision(resolvedRoot);
        parameters.setEventMetaData(ExecutionEventMetadata.of(resolvedRoot,
                session.getId(),
                ExecutionEventMetadata.turnId(metadata),
                ExecutionAttributes.readLong(metadata, ExecutionEventMetadata.PARENT_TURN_ID),
                resolvedRevision));
        return true;
    }

    /** 会话的根会话 id：子会话回指其根，根会话指向自身；根字段缺失时回落自身 id。 */
    private long resolveRootSessionId(Session session) {
        Long rootSessionId = session.getRootSessionId();
        return rootSessionId == null || rootSessionId == Session.ROOT_SESSION_ID
                ? session.getId()
                : rootSessionId;
    }

    /** 根会话的历史代际；根行缺失或代际非法时回落 1（会话默认值）。 */
    private long resolveHistoryRevision(long rootSessionId) {
        Session root = sessionRepository.findById(rootSessionId).orElse(null);
        Long revision = root == null ? null : root.getHistoryRevision();
        return revision == null || revision <= 0L ? 1L : revision;
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
