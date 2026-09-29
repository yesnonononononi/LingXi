package com.summit.dp.tools.baseTools.sub_agent.session;

import cn.hutool.core.util.IdUtil;
import com.summit.core.conversation.message.Message;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.TokenUsage;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.context.SessionContextEntity;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Optional;

/**
 * 子会话的「复用或派生」判定，以及会话行的落库。
 *
 * <p>同一根会话下的同一 Agent 只维护<b>一个</b>子会话：委派前先按
 * {@code (root_session_id, agent_id)} 查找既存会话，命中即复用并带上其历史；
 * 只有查无时才派生新 id 并在通过取消校验后建行。无脑派生会让同一次协作在会话列表里
 * 堆出多个重复子会话，也让「找同一个同事接着聊」失去落脚点。</p>
 */
@Component
@RequiredArgsConstructor
public class SubSessionResolver {

    private final SessionRepository sessionRepository;
    private final ModelContextService modelContextService;

    /**
     * 解析本次委派应落到哪个子会话：命中已有则复用，否则派生新会话。
     *
     * <p><b>复用判据</b>：{@code root_session_id + agent_id} 同时相等。命中时把该会话的
     * {@code session_context} 作为本次执行的既有上下文一并返回 —— 框架约定
     * {@code AgentRequest.messages} 是执行期对话历史的唯一来源（运行时不按 id 回读），
     * 不在这里把历史交出去，子 Agent 就会「接着聊」却看不到之前聊过什么。</p>
     *
     * <p><b>上下文缺失只降级、不回退</b>：{@code session_context} 可能因压缩失败或历史数据
     * 未迁移而不存在，此时返回空历史，绝不让复用失败而退化成派生 —— 那会凭空产生第二个子会话。</p>
     *
     * <p>根会话 id 为空（无法归属）时不查库，直接派生：没有 root 就建立不出复用键。</p>
     *
     * <p>本方法<b>只读</b>：不写任何会话行。建行时机交给 {@link #createSubSession}，
     * 由调用方在确认未取到「主会话已停止」的取消信号后再调用。</p>
     *
     * @param rootSessionId 根会话 id，可为 null
     * @param agent         本次被委派的 Agent
     */
    public SubSessionTarget resolve(Long rootSessionId, AgentVO agent) {
        if (rootSessionId != null && agent != null) {
            Optional<Session> existing = sessionRepository.findByRootAndAgent(rootSessionId, agent.getId());
            if (existing.isPresent()) {
                Long subSessionId = existing.get().getId();
                List<Message> priorMessages = modelContextService.find(subSessionId).orElse(List.of());
                return SubSessionTarget.reused(String.valueOf(subSessionId), priorMessages);
            }
        }
        return SubSessionTarget.fresh(String.valueOf(IdUtil.getSnowflakeNextId()));
    }

    /**
     * 为首次委派补一条子会话 {@code session} 行；复用路径<b>不得</b>调用（重复 insert 会主键冲突）。
     *
     * <p>此前子会话只存在于内存登记与 SSE 映射里，{@code session} 表没有对应行，导致
     * {@code GET /session/{id}/tree} 查不到子会话、级联删除漏删其消息 / 上下文 / 工具调用、
     * {@code root_session_id} 链路断裂。落库时机必须早于子会话第一条消息 / 上下文快照 ——
     * 消息必须挂在已存在的会话上。</p>
     *
     * <p>写入的 {@code agent_id} 正是复用键的另一半，由 {@link SessionContextEntity} 的委派
     * 上下文与工具参数共同确定，不从会话名反推。</p>
     */
    public void createSubSession(Long subSessionId, Long rootSessionId, Long workspaceId, AgentVO agent, String task) {
        Session subSession = Session.builder()
                .id(subSessionId)
                .rootSessionId(rootSessionId == null ? Session.ROOT_SESSION_ID : rootSessionId)
                .agentId(agent == null ? null : agent.getId())
                .workspaceId(workspaceId)
                .name(subSessionName(agent, task))
                .tokenUsage(TokenUsage.empty())
                .build();
        sessionRepository.saveAndReturnId(subSession);
    }

    /** 子会话名：优先取子代理名，其次退化为任务摘要；与根会话一致地截断到上限长度。 */
    private static String subSessionName(AgentVO agent, String task) {
        String base = agent != null && agent.getName() != null && !agent.getName().isBlank()
                ? agent.getName()
                : task;
        if (base == null || base.isBlank()) {
            return "子代理会话";
        }
        String normalized = base.strip().replaceAll("\\s+", " ");
        int end = normalized.offsetByCodePoints(0,
                Math.min(normalized.codePointCount(0, normalized.length()), Session.MAX_SESSION_NAME_LENGTH));
        return normalized.substring(0, end);
    }
}
