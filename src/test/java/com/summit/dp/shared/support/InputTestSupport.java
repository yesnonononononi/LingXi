package com.summit.dp.shared.support;

import java.util.Map;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.beans.factory.ObjectProvider;
import com.summit.dp.workflow.application.input.InputTurnContinuation;
import com.summit.dp.workflow.application.input.InputNoticeReporter;
import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.workflow.application.input.InputResolver;
import com.summit.dp.workflow.application.lifecycle.SubExecutionDependency;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.MailInputSource;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubExecutionInputSource;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskInputSource;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskNotifications;

import java.util.List;

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
                provider(ExecutionResumeCoordinator.class, coordinator),
                provider(InputTurnContinuation.class, mock(InputTurnContinuation.class)));
    }

    private static <T> ObjectProvider<T> provider(Class<T> type, T value) {
        return new StaticListableBeanFactory(Map.of("value", value)).getBeanProvider(type);
    }

    public static InputResolver collaboration(SessionExecutionRegistry registry, EmailService emails) {
        SubExecutionDependency dependency = new SubExecutionDependency(registry,
                mock(SessionRepository.class), mock(ExecutionRepositoryImpl.class));
        return new InputResolver(List.of(new MailInputSource(emails), new SubExecutionInputSource(dependency)),
                new ObjectMapper().findAndRegisterModules());
    }

    public static InputResolver background(TaskRepository tasks, BackgroundTaskNotifications notifications) {
        return new InputResolver(List.of(new BackgroundTaskInputSource(tasks, notifications)),
                new ObjectMapper().findAndRegisterModules());
    }
}
