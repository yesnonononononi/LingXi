package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopMessages;
import com.summit.dp.checklist.application.ChecklistCommand;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.checklist.domain.model.ChecklistStatus;
import com.summit.dp.checklist.support.ChecklistTestDatabase;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskLoopInterceptor;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskNotifications;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * 提醒拦截器的三条路径（首次提醒 → 续轮、二次无进展 → UNFINISHED、推进后额度重置）
 * 以及顺序语义的固化。
 *
 * <p>用真 H2 + 真服务：提醒判定里最关键的是「条件更新影响了几行」，
 * 用替身服务就把这件事测没了。</p>
 */
class ChecklistReminderInterceptorTest {

    private static final long SESSION_ID = 6001L;
    private static final String EXECUTION_ID = "1001";

    private ChecklistTestDatabase fixture;
    private ChecklistService service;
    private ChecklistReminderInterceptor interceptor;

    @BeforeEach
    void setUp() {
        fixture = ChecklistTestDatabase.start("checklist-reminder");
        service = fixture.service();
        interceptor = new ChecklistReminderInterceptor(service, new ChecklistContextInjector(service), new ChecklistReminderDelivery());
    }

    @AfterEach
    void tearDown() {
        if (fixture != null) {
            fixture.close();
        }
    }

    @Test
    @DisplayName("首次自然收尾仍有待处理步骤：注入提醒并显式续轮")
    void firstNaturalCompletionRemindsAndContinuesTheLoop() {
        ChecklistVO created = service.create(ChecklistCommand.create(
                SESSION_ID, null, "本次任务", List.of("写领域层", "跑测试")));
        Execution execution = execution(true);
        List<Message> appended = new ArrayList<>();

        InterceptorResult result = interceptor.onBeforeComplete(context(execution, appended));

        assertFalse(result.next(), "必须短路当前拦截器链，不能再让后续链路改动结局");
        assertTrue(result.loopResult().shouldContinue(), "续轮必须是显式 CONTINUE");
        assertEquals(1, appended.size());
        String text = ((UserMessageEntity) appended.getFirst()).text();
        assertTrue(text.contains("本次任务"), text);
        assertTrue(text.contains("update_checklist_step"), text);
        assertTrue(text.contains(String.valueOf(created.getSteps().getFirst().getStepId())),
                "提醒必须给出稳定 stepId: " + text);
        assertTrue(text.contains("写领域层"), text);

        assertTrue(fixture.repository().findByIdWithSteps(created.getChecklistId()).orElseThrow().isRemindStatus(),
                "额度必须在同一事务里被占用");
    }

    @Test
    @DisplayName("再次自然收尾仍无实际推进：清单置 UNFINISHED 并放行完成")
    void secondCompletionWithoutProgressClosesChecklistAsUnfinished() {
        ChecklistVO created = service.create(ChecklistCommand.create(
                SESSION_ID, null, "本次任务", List.of("写领域层", "跑测试")));

        Execution execution = execution(true);
        InterceptorResult first = interceptor.onBeforeComplete(context(execution, new ArrayList<>()));
        assertTrue(first.loopResult().shouldContinue());

        List<Message> secondAppended = new ArrayList<>();
        InterceptorResult second = interceptor.onBeforeComplete(context(execution, secondAppended));

        assertTrue(second.next(), "放行时应当允许后续拦截器继续");
        assertTrue(second.loopResult().shouldContinue(), "放行不是显式终态");
        assertTrue(secondAppended.isEmpty(), "额度用尽后不得再注入提醒");
        assertEquals(ChecklistStatus.UNFINISHED,
                fixture.repository().findByIdWithSteps(created.getChecklistId()).orElseThrow().getStatus());
    }

    @Test
    @DisplayName("步骤真的推进后额度重置：下一次自然收尾会再提醒一次")
    void advancingAStepRestoresTheReminderQuota() {
        ChecklistVO created = service.create(ChecklistCommand.create(
                SESSION_ID, null, "本次任务", List.of("写领域层", "跑测试")));
        interceptor.onBeforeComplete(context(execution(true), new ArrayList<>()));

        service.updateStep(ChecklistCommand.updateStep(SESSION_ID, created.getChecklistId(),
                created.getSteps().getFirst().getStepId(), "COMPLETED"));

        List<Message> appended = new ArrayList<>();
        InterceptorResult result = interceptor.onBeforeComplete(context(execution(true), appended));

        assertTrue(result.loopResult().shouldContinue(), "实际推进后必须再拿到一次提醒");
        assertEquals(1, appended.size());
        assertEquals(ChecklistStatus.ACTIVE,
                fixture.repository().findByIdWithSteps(created.getChecklistId()).orElseThrow().getStatus());
    }

    @Test
    @DisplayName("没有 update_checklist_step 时不提醒、不消费额度")
    void missingUpdateCapabilityNeverConsumesTheQuota() {
        ChecklistVO created = service.create(ChecklistCommand.create(
                SESSION_ID, null, "本次任务", List.of("写领域层")));
        Execution execution = execution(false);

        InterceptorResult result = interceptor.onBeforeComplete(context(execution, new ArrayList<>()));

        assertTrue(result.next());
        assertTrue(result.loopResult().shouldContinue());
        assertFalse(fixture.repository().findByIdWithSteps(created.getChecklistId()).orElseThrow().isRemindStatus(),
                "没有更新工具的执行不能消耗额度");
    }

    @Test
    @DisplayName("会话没有活动清单时直接放行")
    void noActiveChecklistPassesThrough() {
        InterceptorResult result = interceptor.onBeforeComplete(context(execution(true), new ArrayList<>()));

        assertTrue(result.next());
        assertTrue(result.loopResult().shouldContinue());
    }

    @Test
    @DisplayName("顺序语义：必须晚于后台任务等待，且异常不得被吞")
    void orderStaysAfterTheBackgroundTaskWaitAndErrorsPropagate() {
        ChecklistReminderInterceptor reminder = new ChecklistReminderInterceptor(
                mock(ChecklistService.class), mock(ChecklistContextInjector.class), new ChecklistReminderDelivery());
        BackgroundTaskLoopInterceptor background = new BackgroundTaskLoopInterceptor(
                mock(TaskRepository.class), mock(BackgroundTaskNotifications.class),
                mock(ExecutionResumeCoordinator.class));

        assertEquals(-650, background.order(), "后台任务等待的顺序是前提，改动它就该重审本用例");
        assertEquals(-600, reminder.order());
        assertTrue(reminder.order() > background.order(),
                "提醒必须排在后台任务挂起之后：抢在前面续轮会吞掉挂起，还先花掉提醒额度");
        assertFalse(reminder.catchErr(), "状态写入或注入失败必须上抛");
    }

    @Test
    @DisplayName("上下文注入有界：同一进展版本只补一次，推进后才再补")
    void contextInjectionIsBoundedPerProgressVersion() {
        ChecklistVO created = service.create(ChecklistCommand.create(
                SESSION_ID, null, "本次任务", List.of("写领域层", "跑测试")));
        Execution execution = execution(true);
        List<Message> appended = new ArrayList<>();

        interceptor.onBeforeModelInvoke(context(execution, appended));
        interceptor.onBeforeModelInvoke(context(execution, appended));
        assertEquals(1, appended.size(), "同一进展版本的重复轮次不得重复注入");

        service.updateStep(ChecklistCommand.updateStep(SESSION_ID, created.getChecklistId(),
                created.getSteps().getFirst().getStepId(), "COMPLETED"));
        interceptor.onBeforeModelInvoke(context(execution, appended));
        assertEquals(2, appended.size(), "推进后应再补一次新状态");
    }

    private Execution execution(boolean withChecklistTools) {
        List<String> tools = withChecklistTools
                ? List.of(ToolCatalog.CREATE_CHECKLIST, ToolCatalog.UPDATE_CHECKLIST_STEP,
                    ToolCatalog.MODIFY_CHECKLIST, ToolCatalog.DELETE_CHECKLIST)
                : List.of(ToolCatalog.READ_FILE);
        AgentRequest request = AgentRequest.builder()
                .toolList(tools)
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID)))
                        .build())
                .build();
        return Execution.builder().id(EXECUTION_ID).agentRequest(request).messages(new ArrayList<>()).build();
    }

    private LoopContext context(Execution execution, List<Message> appended) {
        LoopMessages messages = LoopMessages.builder().execution(execution).build();
        return LoopContext.withCompactionCounter(messages, null, () -> 0, added -> {
            appended.addAll(added);
            execution.getMessages().addAll(added);
        });
    }
}
