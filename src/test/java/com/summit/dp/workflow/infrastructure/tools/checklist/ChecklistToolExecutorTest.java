package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.checklist.application.ChecklistCommand;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 四个 Executor 只做「解析参数 → 委派服务 → 翻译结果」。
 *
 * <p>业务规则（唯一 ACTIVE、状态机、跨会话拒绝）在 {@code ChecklistServiceImpl} 与聚合里，
 * 已有真实 H2 用例覆盖；这里用替身服务专测参数面与会话归属解析，
 * 顺带证明 Executor 不会自己猜会话或吞掉业务错误。</p>
 */
class ChecklistToolExecutorTest {

    private static final long SESSION_ID = 4242L;
    private static final long AGENT_ID = 77L;

    // Spring 容器注入的 ObjectMapper 已注册 JavaTime 模块；单测里显式补上，避免拿 Instant 当借口改实现
    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();
    private final ChecklistService service = mock(ChecklistService.class);

    @Test
    @DisplayName("create_checklist 正常路径：会话与 Agent 来自执行上下文，返回权威快照")
    void createDelegatesWithSessionFromContext() throws Exception {
        when(service.create(any())).thenReturn(snapshot("ACTIVE"));

        ToolExecuteResult result = new CreateChecklistTool(objectMapper, service)
                .execute(execution(Map.of("title", "本次任务", "steps", List.of("读计划书", "写代码"))));

        assertTrue(result.isSuccess(), result.getToolOutput());
        ArgumentCaptor<ChecklistCommand> captor = ArgumentCaptor.forClass(ChecklistCommand.class);
        verify(service).create(captor.capture());
        assertEquals(SESSION_ID, captor.getValue().getSessionId(), "会话必须从执行属性解析");
        assertEquals(AGENT_ID, captor.getValue().getAgentId(), "Agent 标识应当被记录");
        assertEquals(List.of("读计划书", "写代码"), captor.getValue().getSteps());

        JsonNode payload = objectMapper.readTree(result.getToolOutput());
        assertEquals(9001L, payload.path("checklistId").asLong());
        assertFalse(payload.has("checklist"));
        assertNotNull(payload.path("hint").asText());
    }

    @Test
    @DisplayName("create_checklist 业务拒绝：把中文原因原样回给模型，不让异常冒出去")
    void createTranslatesBusinessRejection() throws Exception {
        when(service.create(any())).thenThrow(new ClientException("当前会话已有活动清单（ID 1），请先更新或删除它"));

        ToolExecuteResult result = new CreateChecklistTool(objectMapper, service)
                .execute(execution(Map.of("title", "重复", "steps", List.of("一步"))));

        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("已有活动清单"), result.getToolOutput());
    }

    @Test
    @DisplayName("参数不是合法 JSON、或为空时给出可读错误，而不是栈")
    void malformedArgumentsProduceReadableErrors() {
        CreateChecklistTool tool = new CreateChecklistTool(objectMapper, service);

        ToolExecuteResult broken = tool.execute(rawExecution("{not json", SESSION_ID));
        assertFalse(broken.isSuccess());
        assertTrue(broken.getToolOutput().contains("不是合法 JSON"), broken.getToolOutput());

        ToolExecuteResult empty = tool.execute(rawExecution("   ", SESSION_ID));
        assertFalse(empty.isSuccess());
        assertTrue(empty.getToolOutput().contains("参数不能为空"), empty.getToolOutput());
    }

    @Test
    @DisplayName("update_checklist_step 省略 checklistId 时交给服务按会话定位")
    void updateStepDelegatesWithOptionalChecklistId() throws Exception {
        when(service.updateStep(any())).thenReturn(snapshot("ACTIVE"));

        ToolExecuteResult result = new UpdateChecklistStepTool(objectMapper, service)
                .execute(execution(Map.of("stepId", 11L, "status", "COMPLETED")));

        assertTrue(result.isSuccess(), result.getToolOutput());
        ArgumentCaptor<ChecklistCommand> captor = ArgumentCaptor.forClass(ChecklistCommand.class);
        verify(service).updateStep(captor.capture());
        assertEquals(11L, captor.getValue().getStepId());
        assertEquals("COMPLETED", captor.getValue().getStatus());
        assertFalse(captor.getValue().isContinueNextStep());
        assertEquals(null, captor.getValue().getChecklistId(), "未给出清单标识时应保持为空");
    }

    @Test
    void updateForwardsContinueNextStepFlag() throws Exception {
        when(service.updateStep(any())).thenReturn(snapshot("ACTIVE"));
        ToolExecuteResult result = new UpdateChecklistStepTool(objectMapper, service)
                .execute(execution(Map.of("stepId", 11L, "status", "COMPLETED", "continueNextStep", true)));
        assertTrue(result.isSuccess(), result.getToolOutput());
        ArgumentCaptor<ChecklistCommand> captor = ArgumentCaptor.forClass(ChecklistCommand.class);
        verify(service).updateStep(captor.capture());
        assertTrue(captor.getValue().isContinueNextStep());
    }

    @Test
    @DisplayName("update_checklist_step 的状态非法由服务拒绝，Executor 原样回执")
    void updateStepRejectsIllegalStatus() throws Exception {
        when(service.updateStep(any())).thenThrow(new ClientException("步骤状态 DONE 不合法"));

        ToolExecuteResult result = new UpdateChecklistStepTool(objectMapper, service)
                .execute(execution(Map.of("stepId", 11L, "status", "DONE")));

        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("不合法"), result.getToolOutput());
    }

    @Test
    @DisplayName("modify_checklist 把嵌套补丁翻译成应用层补丁项")
    void modifyTranslatesNestedPatch() throws Exception {
        when(service.modify(any())).thenReturn(snapshot("ACTIVE"));
        Map<String, Object> args = Map.of(
                "checklistId", 9001L,
                "newTitle", "新标题",
                "stepContents", List.of(Map.of("stepId", 11L, "content", "编译整个仓库")),
                "addSteps", List.of("写验证记录"),
                "removeStepIds", List.of(12L),
                "orderedStepIds", List.of(11L, 13L));

        ToolExecuteResult result = new ModifyChecklistTool(objectMapper, service).execute(execution(args));

        assertTrue(result.isSuccess(), result.getToolOutput());
        ArgumentCaptor<ChecklistCommand> captor = ArgumentCaptor.forClass(ChecklistCommand.class);
        verify(service).modify(captor.capture());
        assertEquals("新标题", captor.getValue().getNewTitle());
        assertEquals(1, captor.getValue().getStepContents().size());
        assertEquals(11L, captor.getValue().getStepContents().getFirst().stepId());
        assertEquals("编译整个仓库", captor.getValue().getStepContents().getFirst().content());
        assertEquals(List.of("写验证记录"), captor.getValue().getAddedSteps());
        assertEquals(List.of(12L), captor.getValue().getRemovedStepIds());
        assertEquals(List.of(11L, 13L), captor.getValue().getOrderedStepIds());
    }

    @Test
    @DisplayName("delete_checklist 只传权威清单标识与会话，重复删除的语义由服务保证")
    void deleteDelegatesAuthoritativeId() throws Exception {
        when(service.delete(any())).thenReturn(snapshot("DELETED"));

        ToolExecuteResult result = new DeleteChecklistTool(objectMapper, service)
                .execute(execution(Map.of("checklistId", 9001L)));

        assertTrue(result.isSuccess(), result.getToolOutput());
        ArgumentCaptor<ChecklistCommand> captor = ArgumentCaptor.forClass(ChecklistCommand.class);
        verify(service).delete(captor.capture());
        assertEquals(SESSION_ID, captor.getValue().getSessionId());
        assertEquals(9001L, captor.getValue().getChecklistId());
        assertFalse(captor.getValue().isCompleteOpenSteps());
        assertTrue(result.getToolOutput().contains("DELETED"), result.getToolOutput());
    }

    @Test
    void deleteForwardsExplicitCompletionFlag() throws Exception {
        when(service.delete(any())).thenReturn(snapshot("DELETED"));
        ToolExecuteResult result = new DeleteChecklistTool(objectMapper, service)
                .execute(execution(Map.of("checklistId", 9001L, "completeOpenSteps", true)));
        assertTrue(result.isSuccess(), result.getToolOutput());
        ArgumentCaptor<ChecklistCommand> captor = ArgumentCaptor.forClass(ChecklistCommand.class);
        verify(service).delete(captor.capture());
        assertTrue(captor.getValue().isCompleteOpenSteps());
    }

    @Test
    @DisplayName("delete_checklist 缺 checklistId 时由服务拒绝并回可读文案")
    void deleteRequiresChecklistId() throws Exception {
        when(service.delete(any())).thenThrow(new ClientException("删除清单需要提供 checklistId"));

        ToolExecuteResult result = new DeleteChecklistTool(objectMapper, service).execute(execution(Map.of()));

        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("checklistId"), result.getToolOutput());
    }

    private ToolExecution execution(Map<String, Object> args) throws Exception {
        return rawExecution(objectMapper.writeValueAsString(args), SESSION_ID);
    }

    private ToolExecution rawExecution(String args, long sessionId) {
        return ToolExecution.builder()
                .id("call-1").executionId("1001").turnId("2002").args(args)
                .attributes(Map.of(ExecutionAttributes.SESSION_ID, sessionId,
                        ExecutionAttributes.AGENT_ID, AGENT_ID))
                .build();
    }

    private ChecklistVO snapshot(String status) {
        return ChecklistVO.builder()
                .checklistId(9001L)
                .sessionId(SESSION_ID)
                .agentId(AGENT_ID)
                .title("本次任务")
                .status(status)
                .progressVersion(1L)
                .createAt(Instant.now())
                .updateAt(Instant.now())
                .steps(List.of(ChecklistVO.StepVO.builder().stepId(11L).seq(1).content("第一步")
                        .status("PENDING").updateAt(Instant.now()).build()))
                .build();
    }
}
