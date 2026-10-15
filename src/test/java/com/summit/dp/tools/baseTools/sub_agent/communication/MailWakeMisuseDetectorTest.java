package com.summit.dp.tools.baseTools.sub_agent.communication;

import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.MailWakeMisuseDetector;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 唤醒误用判定的决策表。
 *
 * <p>提醒只在「发送方是主理人（根执行）」且「收件队员当前没有在跑的执行」时出现 ——
 * 这两个条件各自都能单独把结果压回空：队员在跑时邮件是有效通道，成员之间的通信则根本不是
 * 本提醒的适用面。少判任何一条，都会在正常协作里制造假提醒。</p>
 */
class MailWakeMisuseDetectorTest {

    private static final long ROOT_SESSION_ID = 405L;
    private static final long COMMANDER_AGENT_ID = 100L;
    private static final long MEMBER_AGENT_ID = 7L;
    private static final long SUB_SESSION_ID = 7002L;

    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final ExecutionLocator executionLocator = mock(ExecutionLocator.class);
    private final MailWakeMisuseDetector detector = new MailWakeMisuseDetector(sessionRepository, executionLocator);

    @Test
    @DisplayName("主理人发给已收工的队员：提醒「以不正确的方式委派并唤醒成员」并给出 call_sub_agent 指引")
    void commanderMailingAnIdleMemberIsWarned() {
        givenExistingSubSession();
        when(executionLocator.activeExecutionIds(SUB_SESSION_ID)).thenReturn(List.of());

        String reminder = detector.detect(commanderAttributes(), MEMBER_AGENT_ID, ROOT_SESSION_ID).orElseThrow();

        assertTrue(reminder.contains("你正在尝试以不正确的方式委派并唤醒成员"),
                "正文须与约定口径一致，否则模型不知道自己正在做错事");
        assertTrue(reminder.contains("call_sub_agent"), "必须给出可执行的替代动作，只指出错误不构成纠正");
        assertTrue(reminder.contains(String.valueOf(MEMBER_AGENT_ID)), "点明收件 Agent，避免模型认错对象");
    }

    @Test
    @DisplayName("主理人发给从未被委派的队员：同样提醒 —— 那封信也没有执行会读到")
    void commanderMailingANeverDelegatedMemberIsWarned() {
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, MEMBER_AGENT_ID)).thenReturn(Optional.empty());

        assertTrue(detector.detect(commanderAttributes(), MEMBER_AGENT_ID, ROOT_SESSION_ID).isPresent(),
                "从未被委派等价于「没有执行会读到这封信」，与已收工同一处置");
    }

    @Test
    @DisplayName("主理人发给仍在跑的队员：不提醒 —— 邮件对它是有效通道")
    void commanderMailingARunningMemberIsNotWarned() {
        givenExistingSubSession();
        when(executionLocator.activeExecutionIds(SUB_SESSION_ID)).thenReturn(List.of("1234"));

        assertTrue(detector.detect(commanderAttributes(), MEMBER_AGENT_ID, ROOT_SESSION_ID).isEmpty(),
                "队员仍在跑时邮件会在它下一轮被读到，提醒会变成噪音");
    }

    @Test
    @DisplayName("成员发信（子执行）：永不提醒，哪怕收件人没有在跑")
    void memberSendingIsNeverWarned() {
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, MEMBER_AGENT_ID)).thenReturn(Optional.empty());

        Map<String, Object> memberAttributes = Map.of(
                ExecutionAttributes.AGENT_ID, "8",
                ExecutionAttributes.SESSION_ID, "7002",
                ExecutionAttributes.ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID),
                ExecutionAttributes.ROOT_EXECUTION_ID, "900");

        assertTrue(detector.detect(memberAttributes, MEMBER_AGENT_ID, ROOT_SESSION_ID).isEmpty(),
                "成员→主理人/成员方向不在适用面内；只看「收件方没在跑」会误伤成员之间的通信");
    }

    @Test
    @DisplayName("主理人发给自己的 agentId：不提醒（自己不是被唤醒的队员）")
    void commanderMailingItselfIsNotWarned() {
        assertTrue(detector.detect(commanderAttributes(), COMMANDER_AGENT_ID, ROOT_SESSION_ID).isEmpty());
    }

    @Test
    @DisplayName("上下文缺失：收件人或根会话解析不出时不提醒，不做无对象的判定")
    void missingContextIsNotWarned() {
        assertTrue(detector.detect(commanderAttributes(), null, ROOT_SESSION_ID).isEmpty());
        assertTrue(detector.detect(commanderAttributes(), MEMBER_AGENT_ID, null).isEmpty());
    }

    /** 主理人（根执行）的受控属性：根执行没有 {@code ROOT_EXECUTION_ID}，这正是「发送方是主理人」的判据。 */
    private static Map<String, Object> commanderAttributes() {
        return Map.of(ExecutionAttributes.AGENT_ID, String.valueOf(COMMANDER_AGENT_ID),
                ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID));
    }

    private void givenExistingSubSession() {
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, MEMBER_AGENT_ID))
                .thenReturn(Optional.of(Session.builder().id(SUB_SESSION_ID).build()));
    }
}
