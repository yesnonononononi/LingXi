package com.summit.dp.shared.support;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.workflow.application.input.*;
import com.summit.dp.workflow.application.lifecycle.*;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskNotifications;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

import java.util.List;
import java.util.Map;

import static org.mockito.Mockito.mock;

/** 旧场景也使用生产来源，避免测试只验证另一套查询规则。 */
public final class InputTestSupport {
    private InputTestSupport() { }

    public static List<Execution> latestStoredExecution(long id) {
        Execution execution = new Execution();
        execution.setId(id);
        return List.of(execution);
    }

    public static InputWakeupService wakeup(ExecutionResumeCoordinator coordinator, ExecutionRepository executions,
                                            ExecutionActivity activity, SessionExecutionRegistry registry, EmailService emails) {
        return new InputWakeupService(provider(ExecutionRepository.class, executions), provider(ExecutionActivity.class, activity),
                collaboration(registry, emails), new InputAutomationPolicy(registry), mock(InputNoticeReporter.class),
                provider(ResumeAcceptancePort.class, new CoordinatorResumeAcceptance(coordinator)),
                provider(InputTurnContinuation.class, mock(InputTurnContinuation.class)),
                new SuspensionGateChain(List.of(new UserPauseSuspensionGate())));
    }

    private static <T> ObjectProvider<T> provider(Class<T> type, T value) {
        return new StaticListableBeanFactory(Map.of("value", value)).getBeanProvider(type);
    }

    public static InputResolver collaboration(SessionExecutionRegistry registry, EmailService emails) {
        SubExecutionDependency dependency = new SubExecutionDependency(registry,
                mock(SessionRepository.class), mock(ExecutionRepositoryImpl.class));
        return new InputResolver(new MailInputChannel(emails), new SubExecutionResultChannel(dependency),
                new BackgroundTaskChannel(mock(TaskRepository.class), new BackgroundTaskNotifications()),
                new ObjectMapper().findAndRegisterModules());
    }

    public static InputResolver background(TaskRepository tasks, BackgroundTaskNotifications notifications) {
        SubExecutionDependency noDependency = new SubExecutionDependency(new SessionExecutionRegistry(),
                mock(SessionRepository.class), mock(ExecutionRepositoryImpl.class));
        return new InputResolver(new MailInputChannel(mock(EmailService.class)),
                new SubExecutionResultChannel(noDependency),
                new BackgroundTaskChannel(tasks, notifications),
                new ObjectMapper().findAndRegisterModules());
    }
}
