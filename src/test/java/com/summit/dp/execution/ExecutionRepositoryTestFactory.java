package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.application.input.MailReceiptFlusher;
import com.summit.dp.workflow.application.lifecycle.ExecutionLifecycleProjection;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.ApplicationEventPublisher;

import java.nio.file.Path;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 测试只替换无关模块，执行仓储与指定轮次服务保持真实实现。 */
public final class ExecutionRepositoryTestFactory {
    private ExecutionRepositoryTestFactory() {
    }

    /**
     * 便捷重载：自动挑一个系统临时目录放检查点文件，进程退出时清理。
     *
     * <p>只关心「保存/恢复语义」的用例不必自己管目录；需要直接看文件的用例走带 {@link Path} 的重载。</p>
     */
    public static LocalExecutionRepository create(ExecutionMapper mapper, ObjectMapper objectMapper) {
        return create(mapper, objectMapper, tempDataDir());
    }

    public static LocalExecutionRepository create(ExecutionMapper mapper, ObjectMapper objectMapper, Path dataDir) {
        return create(mapper, objectMapper, dataDir, mock(ChatTurnService.class));
    }

    /** 给定真实检查点存储的便捷重载：需要自己控制存储（例如并发用例）时用。 */
    public static LocalExecutionRepository create(ExecutionMapper mapper, ObjectMapper objectMapper,
                                                  ExecutionCheckpointStore checkpointStore) {
        return create(mapper, objectMapper, checkpointStore, mock(ChatTurnService.class));
    }

    /** 给定真实轮次服务的便捷重载：临时目录 + 指定 {@link ChatTurnService}。 */
    public static LocalExecutionRepository create(ExecutionMapper mapper, ObjectMapper objectMapper,
                                                  ChatTurnService chatTurnService) {
        return create(mapper, objectMapper, tempDataDir(), chatTurnService);
    }

    public static LocalExecutionRepository create(ExecutionMapper mapper, ObjectMapper objectMapper, Path dataDir,
                                                 ChatTurnService chatTurnService) {
        return create(mapper, objectMapper, new LocalFileCheckpointStore(dataDir.toString(), objectMapper),
                chatTurnService);
    }

    public static LocalExecutionRepository create(ExecutionMapper mapper, ObjectMapper objectMapper,
                                                  ExecutionCheckpointStore checkpointStore,
                                                  ChatTurnService chatTurnService) {
        return new LocalExecutionRepository(
                new ExecutionCheckpointService(new ExecutionRepositoryImpl(mapper), mock(ApplicationEventPublisher.class)),
                objectMapper,
                checkpointStore,
                projectionProvider(chatTurnService),
                mailReceipts());
    }

    /** 给定真实回执协作方：需要断言「回执与检查点同事务」的用例用这条。 */
    public static LocalExecutionRepository create(ExecutionMapper mapper, ObjectMapper objectMapper,
                                                  MailReceiptFlusher mailReceipts) {
        return create(mapper, objectMapper, new LocalFileCheckpointStore(tempDataDir().toString(), objectMapper),
                mock(ChatTurnService.class), mailReceipts);
    }

    /** 给定检查点存储、轮次服务与回执协作方：三者都真实时用这条。 */
    public static LocalExecutionRepository create(ExecutionMapper mapper, ObjectMapper objectMapper,
                                                  ExecutionCheckpointStore checkpointStore,
                                                  ChatTurnService chatTurnService,
                                                  MailReceiptFlusher mailReceipts) {
        return new LocalExecutionRepository(
                new ExecutionCheckpointService(new ExecutionRepositoryImpl(mapper), mock(ApplicationEventPublisher.class)),
                objectMapper,
                checkpointStore,
                projectionProvider(chatTurnService),
                mailReceipts);
    }

    /** 邮件回执协作方：只记录调用、不写库。仓储已把它作为必需依赖，用例必须显式给出。 */
    public static MailReceiptFlusherStub mailReceipts() {
        return new MailReceiptFlusherStub();
    }

    /**
     * 生命周期投影的测试装配：除轮次服务外全部 mock。
     *
     * <p>保留真实的 {@link ChatTurnLifecycleProjector}，因为「轮次有没有收口」是多条端到端用例
     * 唯一能观察到的用户可见结果；投影本身必须是真的，否则被测的是 mock 的回声。</p>
     */
    public static ObjectProvider<ExecutionLifecycleProjection> projectionProvider(ChatTurnService chatTurnService) {
        return provider(projection(chatTurnService));
    }

    /** 不关心任何副作用的用例：连轮次服务也用 mock。 */
    public static ObjectProvider<ExecutionLifecycleProjection> projectionProvider() {
        return provider(projection(mock(ChatTurnService.class)));
    }

    public static ExecutionLifecycleProjection projection(ChatTurnService chatTurnService) {
        return new ExecutionLifecycleProjection(
                provider(mock(ToolCallReadinessService.class)),
                provider(mock(ToolCallService.class)),
                provider(mock(SubExecutionLifecycle.class)),
                provider(mock(SessionContextUsageProjector.class)),
                provider(new ChatTurnLifecycleProjector(chatTurnService)),
                provider(mock(RuntimeEventPublisher.class)),
                provider(mock(InputWakeupService.class)),
                provider(mock(com.summit.dp.execution.domain.repository.ExecutionRepository.class)));
    }

    @SuppressWarnings("unchecked")
    public static <T> ObjectProvider<T> provider(T service) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(service);
        return provider;
    }

    /** 系统临时目录下的数据目录；进程退出时尽力清理，绝不在工作区留检查点文件。 */
    public static Path tempDataDir() {
        try {
            Path directory = java.nio.file.Files.createTempDirectory("lingxi-checkpoints-");
            Runtime.getRuntime().addShutdownHook(new Thread(() -> deleteQuietly(directory),
                    "checkpoint-test-cleanup"));
            return directory;
        } catch (java.io.IOException e) {
            throw new java.io.UncheckedIOException("创建检查点测试目录失败", e);
        }
    }

    private static void deleteQuietly(Path directory) {
        try (java.util.stream.Stream<Path> paths = java.nio.file.Files.walk(directory)) {
            paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try {
                    java.nio.file.Files.deleteIfExists(path);
                } catch (java.io.IOException ignored) {
                    // 临时目录由系统兜底清理，不掩盖用例失败。
                }
            });
        } catch (java.io.IOException ignored) {
            // 同上。
        }
    }
}
