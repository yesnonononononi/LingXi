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
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.shared.vo.ModelToolCallVO;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.application.service.ToolCallActionResolver;
import org.springframework.beans.factory.annotation.Autowired;
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

    @Autowired(required = false)
    private ToolCallActionResolver actionResolver;

    /** 领域对象 → 聚合视图；{@code null} 入参返回 {@code null}。 */
    public ToolCallVO toVO(ToolCall toolCall) {
        if (toolCall == null) {
            return null;
        }
        JsonNode content = parse(toolCall.getContent());
        ToolCallActionResolver.Availability availability = actionResolver == null
                ? new ToolCallActionResolver.Availability(List.of(), "互动状态尚未确认")
                : actionResolver.resolveActions(toolCall, resolveKind(toolCall.getContent()), content);
        return assemble(toolCall, content, availability);
    }

    /**
     * 纯计算入口：动作可用性由调用方提供的执行闸门直接算出，<b>不查执行表</b>。
     *
     * <p>用于提交事件与 bootstrap 批量转换 —— 调用方已经持有执行事实（提交事件即刚挂起的执行，
     * bootstrap 已批量读取执行摘要），禁止在发布 DTO 时逐卡隐式回查（§7）。</p>
     *
     * @param gate 已解析的执行侧闸门
     */
    public ToolCallVO toVO(ToolCall toolCall, CardAvailabilityPolicy.ExecutionGate gate) {
        if (toolCall == null) {
            return null;
        }
        JsonNode content = parse(toolCall.getContent());
        ToolCallActionResolver.Availability availability = actionResolver == null
                ? new ToolCallActionResolver.Availability(List.of(), "互动状态尚未确认")
                : actionResolver.resolveActions(toolCall, resolveKind(toolCall.getContent()), content, gate);
        return assemble(toolCall, content, availability);
    }

    /** 组装视图：与动作来源无关，两条入口共用同一映射，避免字段漂移。 */
    private ToolCallVO assemble(ToolCall toolCall, JsonNode content, ToolCallActionResolver.Availability availability) {
        return ToolCallVO.builder()
                .id(toolCall.getId())
                .conversationId(toolCall.getConversationId())
                .sessionMessageId(toolCall.getSessionMessageId())
                .executionId(toolCall.getExecutionId())
                .toolName(toolCall.getToolName())
                .type(toolCall.getType() == null ? null : toolCall.getType().name())
                .status(toolCall.getStatus() == null ? null : toolCall.getStatus().dbValue())
                .version(toolCall.getVersion())
                .allowedActions(availability.allowedActions())
                .unavailableReason(availability.unavailableReason())
                .title(toolCall.getTitle())
                .content(content)
                .rawInput(parse(toolCall.getRawInput()))
                .rawOutput(clientOutput(toolCall))
                .metaData(parse(toolCall.getMetaData()))
                .pending(toolCall.isUnresolved())
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

    /**
     * 下发前裁剪 {@code raw_output}：读文件的结果正文（文件内容）只有模型需要，前端不展示也不使用，
     * 因此不下发 —— 「读了哪个文件、读了哪几行」是 {@code raw_input.args} 的事，本来就在另一列。
     *
     * <p>{@code outcome} 必须保留：前端靠它判成功/失败。裁剪只作用于下发，库里仍是全文，排查不受影响。</p>
     */
    private JsonNode clientOutput(ToolCall toolCall) {
        JsonNode output = parse(toolCall.getRawOutput());
        if (output == null || !output.isObject() || !isReadFile(toolCall.getToolName())) {
            return output;
        }
        ObjectNode trimmed = (ObjectNode) output;
        trimmed.remove(ToolCallKeys.OUTPUT);
        return trimmed;
    }

    /** 读文件工具名判定（对齐 {@link ToolCatalog#READ_FILE}，不另写字面量）。 */
    private static boolean isReadFile(String toolName) {
        return ToolCatalog.READ_FILE.equals(toolName == null ? null : toolName.trim());
    }

    /** 从 {@code content} 提取卡片形态判别字段 {@code kind}；缺失 / 非法返回 {@code null}（降级）。 */
    public ToolCallKind resolveKind(String contentJson) {
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

    /**
     * {@code content.kind=COMMAND}：{@code {kind,command,workDir,shell,workspaceId,intention?,args}}。
     * {@code intention} 从模型 args 提取（缺失/非法时省略键），供审批卡直接展示，前端无需二次解析 args。
     */
    public String commandContent(String command, String workDir, String shell, String workspaceId, String args) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put(ToolCallKeys.KIND, ToolCallKind.COMMAND.name());
        node.put(ToolCallKeys.COMMAND, command);
        node.put(ToolCallKeys.WORK_DIR, workDir);
        node.put(ToolCallKeys.SHELL, shell);
        node.put(ToolCallKeys.WORKSPACE_ID, workspaceId);
        String intention = resolveIntention(args);
        if (intention != null) {
            node.put(ToolCallKeys.INTENTION, intention);
        }
        node.put(ToolCallKeys.ARGS, args);
        return node.toString();
    }

    /** 从模型 args JSON 提取 {@code intention}；args 缺失 / 非法 / 无该字段一律返回 {@code null}。 */
    private String resolveIntention(String argsJson) {
        if (argsJson == null || argsJson.isBlank()) {
            return null;
        }
        try {
            JsonNode intention = objectMapper.readTree(argsJson).get(ToolCallKeys.INTENTION);
            return intention == null || intention.isNull() ? null : intention.asText();
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * {@code content.kind=DELEGATION}：{@code {kind,subSessionId,text}}。
     * {@code subSessionId} 是子执行终态回填时匹配父执行槽位的依据，必须写字符串。
     */
    public String delegationContent(String subSessionId, String task) {
        return delegationContent(subSessionId, null, task);
    }

    public String delegationContent(String subSessionId, String subExecutionId, String task) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put(ToolCallKeys.KIND, ToolCallKind.DELEGATION.name());
        node.put(ToolCallKeys.SUB_SESSION_ID, subSessionId);
        if (subExecutionId != null) node.put(ToolCallKeys.SUB_EXECUTION_ID, subExecutionId);
        node.put(ToolCallKeys.TEXT, task);
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

    /**
     * 从已落库的 {@code raw_output} 读回结论。
     *
     * <p><b>与 {@link #decisionOutcome} 写读同源</b>：决策重试要回「首次实际结论」，
     * 若另写一份解析，键名一改就会静默读到 {@code null}，回执里 {@code decision} 变空。</p>
     *
     * @return 结论；载荷缺失或不可识别时返回 {@code null}（调用方决定降级语义）
     */
    public ToolCallOutcome readOutcome(ToolCall toolCall) {
        JsonNode output = parse(toolCall == null ? null : toolCall.getRawOutput());
        if (output == null || !output.isObject() || !output.hasNonNull(ToolCallKeys.OUTCOME)) {
            return null;
        }
        try {
            return ToolCallOutcome.valueOf(output.get(ToolCallKeys.OUTCOME).asText());
        } catch (IllegalArgumentException unknown) {
            // 历史行里出现过枚举之外的取值：按「结论不可识别」处理，不猜。
            return null;
        }
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
