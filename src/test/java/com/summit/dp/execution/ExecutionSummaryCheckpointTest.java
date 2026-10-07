package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.LocalExecutionRepository;
import com.summit.dp.shared.config.JsonConfig;
import org.junit.jupiter.api.BeforeEach;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * execution 的查询列在检查点保存时同步维护。
 *
 * <p><b>这些断言为什么是行为性的、而不是字段赋值：</b>这些列存在的唯一目的是让「刷新、切走再切回、
 * 暂停恢复之后状态与耗时口径不变」。所以这里验证的是**语义**：未开始就是 null（不是 1970，
 * 也不是 0）、挂起不写结束时间、恢复不重置首次开始时间。</p>
 *
 * <p><b>模型与 token 已不在本表</b>：它们是业务事实，权威在 {@code chat_turn} ——
 * 模型由业务受理时自己解析写入，用量由框架完成事件覆盖回填。执行表只留框架自己的运行记录
 * （状态 / 起止时间），所以这里不再断言模型与用量落库。</p>
 *
 * <p>本测试用真实 {@link LocalExecutionRepository} + mock mapper，捕获真正写进 PO 的列 ——
 * 直接断言「字段被 set 了」没有意义，要断言的是「进 INSERT/UPDATE 语句的列」。</p>
 */
class ExecutionSummaryCheckpointTest {

    private static final long EXECUTION_ID = 305L;
    private static final long SESSION_ID = 405L;
    private static final String MODEL_NAME = "deepseek-chat";
    private static final String MODEL_PROVIDER = "deepseek";

    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    private final ExecutionMapper persistence = mock(ExecutionMapper.class);
    private final LocalExecutionRepository repository =
            ExecutionRepositoryTestFactory.create(persistence, mapper);

    @BeforeEach
    void allowCheckpointWrites() {
        TableInfoHelper.initTableInfo(new MapperBuilderAssistant(new MybatisConfiguration(), "test"), ExecutionPO.class);
        when(persistence.update(any(ExecutionPO.class), any())).thenReturn(1);
        when(persistence.insert(any(ExecutionPO.class))).thenReturn(1);
    }

    /** 一次请求：带模型配置（含连接凭据）与可选的根执行属性。 */
    private static AgentRequest request(Map<String, Object> extraAttributes) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID));
        attributes.putAll(extraAttributes);
        return AgentRequest.builder()
                .executionId(String.valueOf(EXECUTION_ID))
                .messages(List.of(UserMessageEntity.from("hi")))
                .modelConfig(ModelConfig.builder()
                        .baseUrl("https://example.invalid").apiKey("secret-key")
                        .modelName(MODEL_NAME).provider(MODEL_PROVIDER).build())
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.copyOf(attributes)).build())
                .build();
    }

    private static Execution newExecution(Map<String, Object> extraAttributes) {
        return Execution.create(request(extraAttributes), "chatAgent");
    }

    @Test
    @DisplayName("建行即带执行身份；未开始一律为空，不得写成 0 或 1970")
    void createdCheckpointCarriesIdentityAndEmptyLifecycle() {
        Execution execution = newExecution(Map.of());

        repository.save(execution);

        ArgumentCaptor<ExecutionPO> inserted = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence).insert(inserted.capture());
        ExecutionPO row = inserted.getValue();

        assertEquals(EXECUTION_ID, row.getId());
        assertEquals(SESSION_ID, row.getSessionId());
        assertEquals(0, row.getStatus(), "CREATED");

        // 「未知」与「已知为零」必须可区分：没有开始时间就是 null，不是 1970，也不是 0。
        assertNull(row.getStartedAt());
        assertNull(row.getCompletedAt());
    }

    @Test
    @DisplayName("开始时间在 start() 后落库；进行中不得写结束时间；终态才写结束时间")
    void lifecycleTimesFollowExecutionState() {
        Execution execution = newExecution(Map.of());
        repository.save(execution);
        verify(persistence).insert(any(ExecutionPO.class));

        execution.start();
        repository.save(execution);
        ArgumentCaptor<ExecutionPO> rows = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence, times(1)).update(rows.capture(), any());
        assertNotNull(rows.getValue().getStartedAt(), "开始后必须有首次开始时间");
        assertNull(rows.getValue().getCompletedAt(), "还在跑，不得写结束时间");

        execution.complete();
        repository.save(execution);
        verify(persistence, times(2)).update(rows.capture(), any());
        assertNotNull(rows.getValue().getCompletedAt(), "终态必须写结束时间");
        assertEquals(3, rows.getValue().getStatus(), "COMPLETED");
    }

    @Test
    @DisplayName("挂起不是终态：不写结束时间，首次开始时间必须保留")
    void suspensionKeepsFirstStartTimeAndLeavesCompletedAtEmpty() {
        Execution execution = newExecution(Map.of());
        repository.save(execution);
        execution.start();
        repository.save(execution);

        execution.suspend();
        repository.save(execution);

        ArgumentCaptor<ExecutionPO> rows = ArgumentCaptor.forClass(ExecutionPO.class);
        // 只有 start 与 suspend 两次 UPDATE：首次 CREATED 保存走的是 INSERT。
        verify(persistence, times(2)).update(rows.capture(), any());
        ExecutionPO suspended = rows.getValue();

        assertEquals(2, suspended.getStatus(), "SUSPENDED");
        assertNull(suspended.getCompletedAt(), "挂起不是终态，不得写结束时间");
        assertNotNull(suspended.getStartedAt());
    }

    @Test
    @DisplayName("恢复不重置首次开始时间（总历时从第一次开始算）")
    void resumeDoesNotResetFirstStartTime() {
        Execution execution = newExecution(Map.of());
        repository.save(execution);

        execution.start();
        Instant firstStart = execution.getStartAt();
        repository.save(execution);
        execution.suspend();
        repository.save(execution);
        execution.resume();
        repository.save(execution);

        assertEquals(firstStart, execution.getStartAt(), "恢复不得重置首次开始时间");

        ArgumentCaptor<ExecutionPO> rows = ArgumentCaptor.forClass(ExecutionPO.class);
        // 首次 CREATED 保存是 INSERT；start / suspend / resume 三次 UPDATE。
        verify(persistence, times(3)).update(rows.capture(), any());
        assertEquals(LocalDateTime.ofInstant(firstStart, ZoneId.systemDefault()), rows.getValue().getStartedAt());
    }
}
