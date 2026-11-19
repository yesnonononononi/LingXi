package com.summit.dp.workflow.application.chat;

import com.summit.core.agent.Execution;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;

import java.util.List;

/**
 * 一次运行需要的上下文，按语义分成五组：身份、Agent 绑定、会话与工作区、运行档位、上下文载荷。
 *
 * <p><b>为什么分组而不是十四个平级字段</b>：平级字段的构造器是十四个位置参数，其中
 * 五六对是相邻的同行类型（两个 ID、两个布尔、两段消息）。加字段时靠「数第几个」填参，
 * 填错位置编译器不会说话，运行期才在某个分支上炸。分组后新增字段只落在自己的子记录里，
 * 主构造器不再变长。</p>
 *
 * <p><b>扁平访问器只为存量调用点保留</b>：{@code context.turnId()} 等价于
 * {@code context.session().turnId()}。新写的代码请直接用子对象，别再往上加扁平字段。</p>
 *
 * <p>身份不走 ThreadLocal（HC-1），由 {@link ExecutionContext} 显式随调用链传播。</p>
 */
public record RuntimeContext(
        ExecutionContext executionContext,
        AgentSelection agent,
        SessionBinding sessionBinding,
        RunProfile profile,
        ContextPayload payload
) {

    /** 谁在跑：团队优先于单 Agent，两者都为空表示裸模型。 */
    public record AgentSelection(Long agentId, Long teamId) {

        /** 裸模型：没有绑定的 Agent，也没有协作团队。 */
        public static AgentSelection none() {
            return new AgentSelection(null, null);
        }
    }

    /**
     * 跑在哪个会话与工作区，以及受理后才有归属的轮次与执行。
     *
     * <p>{@code turnId} / {@code execution} 在受理事务里填上：解析阶段它们还不存在，
     * 所以只能由 {@code withTurnId} / {@code withExecution} 逐步补齐，不能一次性构造。</p>
     */
    public record SessionBinding(SessionVO session, WorkspaceSpec workspace, Long turnId, Execution execution) {

        /** 受理前：轮次与执行都还没有。 */
        public static SessionBinding beforeAdmission(SessionVO session, WorkspaceSpec workspace) {
            return new SessionBinding(session, workspace, null, null);
        }

        public SessionBinding withTurnId(Long turnId) {
            return new SessionBinding(session, workspace, turnId, execution);
        }

        public SessionBinding withExecution(Execution execution) {
            return new SessionBinding(session, workspace, turnId, execution);
        }
    }

    /**
     * 运行档位：模型连接、能力声明与放行档位。
     *
     * <p>这几项一起决定工具清单怎么组装（识图给视觉工具、计划模式补 create_plan、
     * 档位决定禁用的写工具），所以放在同一组里，改一处时另一处不会漏。</p>
     */
    public record RunProfile(ModelConfig modelConfig, boolean vision,
                             AgentPermissionMode permissionMode, boolean requirePlan) {
    }

    /**
     * 本轮交给模型的东西：历史消息、还没落库的用户消息、重发要复现的上下文规格。
     *
     * @param resendSnapshot 重发专用：目标轮次当时的系统提示词与记忆段；普通请求为 {@code null}
     */
    public record ContextPayload(List<Message> messageList, UserMessageEntity pendingUserMessage,
                                 ResendSnapshot resendSnapshot) {

        public ContextPayload withResendSnapshot(ResendSnapshot resendSnapshot) {
            return new ContextPayload(messageList, pendingUserMessage, resendSnapshot);
        }
    }

    public RuntimeContext withTurnId(Long turnId) {
        return new RuntimeContext(executionContext, agent, sessionBinding.withTurnId(turnId), profile, payload);
    }

    public RuntimeContext withExecution(Execution execution) {
        return new RuntimeContext(executionContext, agent, sessionBinding.withExecution(execution), profile, payload);
    }

    /** 重发：挂上目标轮次的上下文规格，其余分组原样不动。 */
    public RuntimeContext withResendSnapshot(ResendSnapshot resendSnapshot) {
        return new RuntimeContext(executionContext, agent, sessionBinding, profile,
                payload.withResendSnapshot(resendSnapshot));
    }

    // ---- 扁平访问器：仅为存量调用点保留，新代码请用上面的子对象 ----

    public Long agentId() {
        return agent.agentId();
    }

    public Long teamId() {
        return agent.teamId();
    }

    public SessionVO session() {
        return sessionBinding.session();
    }

    public WorkspaceSpec workspace() {
        return sessionBinding.workspace();
    }

    public Long turnId() {
        return sessionBinding.turnId();
    }

    public Execution execution() {
        return sessionBinding.execution();
    }

    public ModelConfig modelConfig() {
        return profile.modelConfig();
    }

    public boolean vision() {
        return profile.vision();
    }

    public AgentPermissionMode permissionMode() {
        return profile.permissionMode();
    }

    public boolean requirePlan() {
        return profile.requirePlan();
    }

    public List<Message> messageList() {
        return payload.messageList();
    }

    public UserMessageEntity pendingUserMessage() {
        return payload.pendingUserMessage();
    }

    public ResendSnapshot resendSnapshot() {
        return payload.resendSnapshot();
    }
}
