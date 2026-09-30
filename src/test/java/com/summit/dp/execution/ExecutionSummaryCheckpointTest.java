package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.LocalExecutionRepository;
import com.summit.dp.shared.config.JsonConfig;
import org.junit.jupiter.api.BeforeEach;
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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * execution 摘要列在检查点保存时同步维护（2026-09-30 改造）。
 *
 * <p><b>为什么这些断言是行为性的、而不是字段赋值：</b>摘要列存在的唯一目的是让「刷新、切走再切回、
 * 暂停恢复之后统计口径不变」。所以这里验证的是**语义**：未开始就是 null（不是 0）、
 * 挂起不写结束时间、恢复不重置首次开始时间、同一累计值重复保存不得翻倍。</p>
 *
 * <p>本测试用真实 {@link LocalExecutionRepository} + mock mapper，捕获真正写进 PO 的列 ——
 * 直接断言「字段被 set 了」没有意义，要断言的是「进 UPDATE 语句的列」。</p>
 */
class ExecutionSummaryCheckpointTest {

    private static final long EXECUTION_ID = 305L;
    private static final long SESSION_ID = 405L;
    private static final String MODEL_NAME = "deepseek-chat";
    private static final String MODEL_PROVIDER = "deepseek";

    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    private final ExecutionMapper persistence = mock(ExecutionMapper.class);
    private final LocalExecutionRepository repository =
            new LocalExecutionRepository(persistence, mapper, List.of());

    @BeforeEach
    void allowCheckpointWrites() {
        when(persistence.updateById(any(ExecutionPO.class))).thenReturn(1);
        when(persistence.insert(any(ExecutionPO.class))).thenReturn(1);
    }

    /** 一次请求：带模型配置（含连接凭据，用于验证摘要列不会把它们写进去）与可选的根执行属性。 */
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
    @DisplayName("建行即带模型快照与根执行归属；未开始/未采集一律为空，不得写成 0")
    void createdCheckpointCarriesSnapshotAndRootExecution() {
        Execution execution = newExecution(Map.of(ExecutionAttributes.ROOT_EXECUTION_ID, "111"));

        repository.save(execution);

        ArgumentCaptor<ExecutionPO> inserted = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence).insert(inserted.capture());
        ExecutionPO row = inserted.getValue();

        assertEquals(EXECUTION_ID, row.getId());
        assertEquals(SESSION_ID, row.getSessionId());
        assertEquals(0, row.getStatus(), "CREATED");
        assertEquals(111L, row.getRootExecutionId());
        assertEquals(MODEL_NAME, row.getModelName(), "模型快照取实际解析后的执行配置");
        assertEquals(MODEL_PROVIDER, row.getModelProvider());

        // 「未知」与「已知为零」必须可区分：没有开始时间就是 null，不是 1970，也不是 0。
        assertNull(row.getStartedAt());
        assertNull(row.getCompletedAt());
        assertNull(row.getInputTokenCount());
        assertNull(row.getOutputTokenCount());
        assertNull(row.getTotalTokenCount());
    }

    @Test
    @DisplayName("主执行没有根执行归属：写 null，不写自身 id（避免与「未知」混淆）")
    void mainExecutionHasNoRootExecutionId() {
        repository.save(newExecution(Map.of()));

        ArgumentCaptor<ExecutionPO> inserted = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence).insert(inserted.capture());
        assertNull(inserted.getValue().getRootExecutionId());
    }

    @Test
    @DisplayName("摘要列只存模型名称与提供方，绝不落连接凭据")
    void summaryColumnsNeverCarryConnectionCredentials() {
        repository.save(newExecution(Map.of()));

        ArgumentCaptor<ExecutionPO> inserted = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence).insert(inserted.capture());
        ExecutionPO row = inserted.getValue();

        assertEquals(MODEL_NAME, row.getModelName());
        assertEquals(MODEL_PROVIDER, row.getModelProvider());
        // 摘要列是给历史接口展示用的，只可能承载这两个字符串；
        // baseUrl / apiKey / timeout 一律不进摘要（它们只存在于框架快照里）。
        assertFalse(MODEL_NAME.contains("secret-key"));
        assertFalse(MODEL_PROVIDER.contains("https://"));
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
        verify(persistence, times(1)).updateById(rows.capture());
        assertNotNull(rows.getValue().getStartedAt(), "开始后必须有首次开始时间");
        assertNull(rows.getValue().getCompletedAt(), "还在跑，不得写结束时间");

        execution.complete();
        repository.save(execution);
        verify(persistence, times(2)).updateById(rows.capture());
        assertNotNull(rows.getValue().getCompletedAt(), "终态必须写结束时间");
        assertEquals(3, rows.getValue().getStatus(), "COMPLETED");
    }

    @Test
    @DisplayName("挂起不是终态：不写结束时间，但已采集的用量与首次开始时间必须保留")
    void suspensionKeepsCountersAndLeavesCompletedAtEmpty() {
        Execution execution = newExecution(Map.of());
        repository.save(execution);
        execution.start();
        execution.setTokenUsage(TokenUsageEntity.of(150, 100, 50));
        repository.save(execution);

        execution.suspended();
        repository.save(execution);

        ArgumentCaptor<ExecutionPO> rows = ArgumentCaptor.forClass(ExecutionPO.class);
        // 只有 start 与 suspend 两次 UPDATE：首次 CREATED 保存走的是 INSERT。
        verify(persistence, times(2)).updateById(rows.capture());
        ExecutionPO suspended = rows.getValue();

        assertEquals(2, suspended.getStatus(), "SUSPENDED");
        assertNull(suspended.getCompletedAt(), "挂起不是终态，不得写结束时间");
        assertEquals(100L, suspended.getInputTokenCount());
        assertEquals(50L, suspended.getOutputTokenCount());
        assertEquals(150L, suspended.getTotalTokenCount());
        assertNotNull(suspended.getStartedAt());
    }

    @Test
    @DisplayName("token 取当前累计值覆盖写入：resume 后终态事件重发，同一执行不得被算两遍")
    void tokenCountersAreOverwrittenNotAccumulated() {
        Execution execution = newExecution(Map.of());
        repository.save(execution);
        execution.start();
        execution.setTokenUsage(TokenUsageEntity.of(150, 100, 50));
        repository.save(execution);

        // 恢复后终态事件会再发一次（带同一份累计值）：必须原样覆盖，而不是再累加。
        execution.resume();
        repository.save(execution);

        ArgumentCaptor<ExecutionPO> rows = ArgumentCaptor.forClass(ExecutionPO.class);
        // 首次 CREATED 保存是 INSERT；start 与 resume 各一次 UPDATE。
        verify(persistence, times(2)).updateById(rows.capture());
        assertEquals(150L, rows.getValue().getTotalTokenCount(), "同一执行重复保存不得翻倍");
        assertEquals(100L, rows.getValue().getInputTokenCount());
    }

    @Test
    @DisplayName("恢复不重置首次开始时间（总历时从第一次开始算）")
    void resumeDoesNotResetFirstStartTime() {
        Execution execution = newExecution(Map.of());
        repository.save(execution);

        execution.start();
        Instant firstStart = execution.getStartAt();
        repository.save(execution);
        execution.suspended();
        repository.save(execution);
        execution.resume();
        repository.save(execution);

        assertEquals(firstStart, execution.getStartAt(), "恢复不得重置首次开始时间");

        ArgumentCaptor<ExecutionPO> rows = ArgumentCaptor.forClass(ExecutionPO.class);
        // 首次 CREATED 保存是 INSERT；start / suspend / resume 三次 UPDATE。
        verify(persistence, times(3)).updateById(rows.capture());
        assertEquals(LocalDateTime.ofInstant(firstStart, ZoneId.systemDefault()), rows.getValue().getStartedAt());
    }

    @Test
    @DisplayName("未采集到用量时留空：null 不进 UPDATE，已知值因此不会被零覆盖")
    void missingUsageStaysNullSoKnownCountersAreNotClobbered() {
        Execution execution = newExecution(Map.of());
        repository.save(execution);
        execution.start();
        // tokenUsage 保持 null：本次执行没有采到任何用量。
        repository.save(execution);

        ArgumentCaptor<ExecutionPO> rows = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence, times(1)).updateById(rows.capture());
        assertNull(rows.getValue().getInputTokenCount(), "未采集到必须是 null，不能伪装成 0");
        assertNull(rows.getValue().getTotalTokenCount());
        // PO 为 null 时，MyBatis-Plus 默认的 NOT_NULL 更新策略不会把该列放进 UPDATE 语句，
        // 因此「空值不覆盖已知数据」是由数据结构 + 策略共同保证的，而不是碰巧成立。
    }
}
