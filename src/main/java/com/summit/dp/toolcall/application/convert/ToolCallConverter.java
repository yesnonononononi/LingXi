package com.summit.dp.toolcall.application.convert;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.shared.vo.ModelToolCallVO;
import com.summit.dp.shared.vo.ToolCallVO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

/**
 * 工具调用领域对象 → 视图对象转换，以及 JSON 载荷「写读同源」构建。
 *
 * <p>JSON 载荷在此解析为 {@link JsonNode}；解析失败时相应字段按「不可用」处理（{@code null}），
 * 消息与卡片不丢、不抛异常。</p>
 *
 * <p><b>键名一律引用 {@link ToolCallKeys}（评审 P2-⑦）：</b>读侧与写侧共用同一常量，
 * 避免键名改名时两侧静默漂移。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ToolCallConverter {

    private final ObjectMapper objectMapper;

    /** 领域对象 → 聚合视图；{@code null} 入参返回 {@code null}。 */
    public ToolCallVO toVO(ToolCall toolCall) {
        if (toolCall == null) {
            return null;
        }
        return ToolCallVO.builder()
                .id(toolCall.getId())
                .conversationId(toolCall.getConversationId())
                .sessionMessageId(toolCall.getSessionMessageId())
                .executionId(toolCall.getExecutionId())
                .toolName(toolCall.getToolName())
                .type(toolCall.getType() == null ? null : toolCall.getType().name())
                .status(toolCall.getStatus() == null ? null : toolCall.getStatus().dbValue())
                .title(toolCall.getTitle())
                .content(parse(toolCall.getContent()))
                .rawInput(parse(toolCall.getRawInput()))
                .rawOutput(parse(toolCall.getRawOutput()))
                .metaData(parse(toolCall.getMetaData()))
                .pending(toolCall.isApprovalPending())
                .createdAt(toolCall.getCreatedAt())
                .updatedAt(toolCall.getUpdatedAt())
                .build();
    }

    /** AI 行「模型请求视图」：{@code ToolCallRequest} → {@link ModelToolCallVO}。 */
    public List<ModelToolCallVO> toModelToolCalls(List<ToolCallRequest> calls) {
        if (calls == null || calls.isEmpty()) {
            return List.of();
        }
        return calls.stream()
                .map(call -> ModelToolCallVO.builder()
                        .id(call.id())
                        .name(call.name())
                        .arguments(call.arguments())
                        .build())
                .toList();
    }

    /** JSON 文本 → 对象；空串 / 非法 JSON 一律降级为 {@code null}。 */
    public JsonNode parse(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            log.warn("工具调用 JSON 载荷解析失败，按不可用处理: {}", e.getMessage());
            return null;
        }
    }

    /** 判断链路的辅助：状态是否 pending。 */
    public static boolean isPending(ToolCall toolCall) {
        return toolCall != null && toolCall.getStatus() == ToolCallStatus.PENDING;
    }

    /** 从 {@code content} 提取卡片形态判别字段 {@code kind}；缺失 / 非法返回 {@code null}（降级）。 */
    public ToolCallKind kindOf(String contentJson) {
        JsonNode node = parse(contentJson);
        if (node == null || !node.hasNonNull(ToolCallKeys.KIND)) {
            return null;
        }
        return ToolCallKind.fromName(node.get(ToolCallKeys.KIND).asText());
    }

    // ------------------------------------------------------------------
    // JSON 载荷构建（写读同源：与设计 §4.4 的 schema 一致）
    // ------------------------------------------------------------------

    /** {@code raw_input} = {@code {"args": <模型args>}}；args 非法 JSON 时按字符串原样内联。 */
    public String rawInput(String argsJson) {
        ObjectNode node = objectMapper.createObjectNode();
        if (argsJson == null) {
            node.putNull(ToolCallKeys.ARGS);
        } else {
            try {
                node.set(ToolCallKeys.ARGS, objectMapper.readTree(argsJson));
            } catch (Exception e) {
                node.put(ToolCallKeys.ARGS, argsJson);
            }
        }
        return node.toString();
    }

    /** {@code meta_data} = {@code {"_meta":{"schemaVersion":1,"executionId":"...","toolName":"..."}}}（id 写字符串）。 */
    public String executionMeta(long executionId, String toolName) {
        ObjectNode meta = objectMapper.createObjectNode();
        meta.put(ToolCallKeys.SCHEMA_VERSION, 1);
        // 手工拼 JSON 树的 ID 必须写字符串：JsonConfig 的 Long→String 不作用于数值节点。
        meta.put(ToolCallKeys.EXECUTION_ID, String.valueOf(executionId));
        meta.put(ToolCallKeys.TOOL_NAME, toolName);
        ObjectNode root = objectMapper.createObjectNode();
        root.set(ToolCallKeys.META, meta);
        return root.toString();
    }

    /** {@code content.kind=PLAN}：{@code {kind,title,text}}。 */
    public String planContent(String title, String text) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put(ToolCallKeys.KIND, ToolCallKind.PLAN.name());
        node.put(ToolCallKeys.TITLE, title);
        node.put(ToolCallKeys.TEXT, text);
        return node.toString();
    }

    /** {@code content.kind=CHOICE}：{@code {kind,question,options[]}}。 */
    public String choiceContent(String question, List<String> options) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put(ToolCallKeys.KIND, ToolCallKind.CHOICE.name());
        node.put(ToolCallKeys.QUESTION, question);
        ArrayNode arr = node.putArray(ToolCallKeys.OPTIONS);
        if (options != null) {
            options.forEach(arr::add);
        }
        return node.toString();
    }

    /** {@code content.kind=COMMAND}：{@code {kind,command,workDir,shell,workspaceId,args}}。 */
    public String commandContent(String command, String workDir, String shell, String workspaceId, String args) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put(ToolCallKeys.KIND, ToolCallKind.COMMAND.name());
        node.put(ToolCallKeys.COMMAND, command);
        node.put(ToolCallKeys.WORK_DIR, workDir);
        node.put(ToolCallKeys.SHELL, shell);
        node.put(ToolCallKeys.WORKSPACE_ID, workspaceId);
        node.put(ToolCallKeys.ARGS, args);
        return node.toString();
    }

    /** {@code raw_output}（PROMISE 结论）：{@code {outcome,answer?,decidedAt?}}。 */
    public String decisionOutcome(ToolCallOutcome outcome, String answer, boolean withDecidedAt) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put(ToolCallKeys.OUTCOME, outcome.value());
        if (answer != null) {
            node.put(ToolCallKeys.ANSWER, answer);
        }
        if (withDecidedAt) {
            node.put(ToolCallKeys.DECIDED_AT, Instant.now().toString());
        }
        return node.toString();
    }

    /** {@code raw_output}（命令批准 / 执行结果）：{@code {outcome,stdout?/output?,reason?}}。 */
    public String commandOutcome(ToolCallOutcome outcome, String stdout, String reason) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put(ToolCallKeys.OUTCOME, outcome.value());
        switch (outcome) {
            case APPROVED, SUCCEEDED -> node.put(ToolCallKeys.STDOUT, stdout == null ? "" : stdout);
            case FAILED, TIMED_OUT -> node.put(ToolCallKeys.OUTPUT, stdout == null ? "" : stdout);
            default -> {
                if (reason != null) {
                    node.put(ToolCallKeys.REASON, reason);
                }
            }
        }
        return node.toString();
    }

    /** {@code raw_output}（EXECUTE 直通结果）：{@code {outcome,output?}}。 */
    public String executeOutcome(ToolCallOutcome outcome, String output) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put(ToolCallKeys.OUTCOME, outcome.value());
        if (output != null) {
            node.put(ToolCallKeys.OUTPUT, output);
        }
        return node.toString();
    }

    /** {@code raw_output}（取消）：{@code {outcome:CANCELLED,reason}}。 */
    public String cancelled(String reason) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put(ToolCallKeys.OUTCOME, ToolCallOutcome.CANCELLED.value());
        node.put(ToolCallKeys.REASON, reason == null ? "执行已取消" : reason);
        return node.toString();
    }
}
