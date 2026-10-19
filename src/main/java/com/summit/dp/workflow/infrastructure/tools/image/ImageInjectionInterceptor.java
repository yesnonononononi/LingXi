package com.summit.dp.workflow.infrastructure.tools.image;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.Image;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.tools.application.port.ToolCatalog;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

/** 工具回执仅含元数据，像素须等工具轮提交后再作为用户消息注入。 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ImageInjectionInterceptor implements LoopInterceptor {

    /** 待注入队列：工具执行时写入，下一轮模型调用前消费。 */
    static final String KEY_PENDING = "lingxi.image.pending";
    /** 已注入过的图片内容哈希：同一次执行内不重复烧 token。 */
    static final String KEY_INJECTED = "lingxi.image.injected";

    private final ImageCacheDirectory cache;

    /** 在邮件注入（-800）之后：两者都追加用户消息，谁先谁后不影响正确性。 */
    @Override
    public int order() {
        return -750;
    }

    /**
     * 异常一律上抛：吞掉之后模型会以为看图成功，继续按想象作答，世界就不一致了。
     * 可预期的失败（缓存文件缺失、读不出来）已在方法内降级成文本说明。
     */
    @Override
    public boolean catchErr() {
        return false;
    }

    /** 只记账，不注入：此刻本轮 {@code assistant(tool_calls)} 还没落进上下文。 */
    @Override
    public InterceptorResult onAfterToolCall(LoopContext context, List<ToolExecuteResult> results) {
        if (results == null || results.isEmpty()) return InterceptorResult.NONE;
        Execution execution = context.getLoopMessages().getExecution();
        List<Map<String, Object>> pending = new ArrayList<>(readPending(execution));
        for (ToolExecuteResult result : results) {
            if (result == null || !result.isSuccess() || result.getToolSpecification() == null
                    || !ToolCatalog.READ_IMAGE.equals(result.getToolSpecification().name())) continue;
            Map<String, Object> metadata = result.getToolMetaData();
            if (metadata == null || metadata.get("imageId") == null) continue;
            pending.add(new HashMap<>(metadata));
        }
        if (!pending.isEmpty()) {
            writeAttributes(execution, attributes -> attributes.put(KEY_PENDING, List.copyOf(pending)));
        }
        return InterceptorResult.NONE;
    }

    @Override
    public InterceptorResult onBeforeModelInvoke(LoopContext context) {
        Execution execution = context.getLoopMessages().getExecution();
        List<Map<String, Object>> pending = readPending(execution);
        if (pending.isEmpty()) return InterceptorResult.NONE;

        Map<String, Object> attributes = attributes(execution);
        Long sessionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.SESSION_ID);
        Set<String> injected = new LinkedHashSet<>(readInjected(execution));
        List<Image> images = new ArrayList<>();
        List<String> lines = new ArrayList<>();

        for (Map<String, Object> entry : pending) {
            String imageId = text(entry.get("imageId"));
            String path = text(entry.get("path"));
            String mimeType = text(entry.get("mimeType"));
            String extension = text(entry.get("ext"));
            if (imageId == null) continue;
            if (injected.contains(imageId)) {
                lines.add("- " + path + "：与之前注入的是同一张图，不重复提供");
                continue;
            }
            // 同一工具轮可并发读取多张，只有汇总后的注入点能守住总量。
            if (readConsumed(attributes) + images.size() >= ReadImageToolExecutor.MAX_IMAGE_BUDGET) {
                lines.add("- " + path + "：本次执行的图片数量已达上限，请不要臆测内容");
                continue;
            }
            if (sessionId == null) {
                lines.add("- " + path + "：会话标识缺失，图片无法注入，请不要臆测内容");
                continue;
            }
            Path cached = cache.resolve(sessionId, imageId, extension);
            if (cached == null) {
                lines.add("- " + path + "：图片已不可用，请不要臆测内容");
                continue;
            }
            try {
                byte[] bytes = Files.readAllBytes(cached);
                images.add(Image.from(Base64.getEncoder().encodeToString(bytes), mimeType));
                injected.add(imageId);
                lines.add("- " + path + "（" + entry.get("width") + "×" + entry.get("height") + "）");
            } catch (IOException unreadable) {
                log.warn("注入图片失败: imageId={}, path={}", imageId, path, unreadable);
                lines.add("- " + path + "：图片读取失败，请不要臆测内容");
            }
        }

        // 队列必须清空：同一张图不能在后续每一轮重复注入。
        int consumed = readConsumed(attributes) + images.size();
        List<String> injectedSnapshot = List.copyOf(injected);
        String intro = images.isEmpty()
                ? "以下是 read_image 的结果说明：\n"
                : "以下是你在上一轮 read_image 读取的图片，现在可以看到它们：\n";
        String text = intro + String.join("\n", lines);
        UserMessageEntity message = images.isEmpty()
                ? UserMessageEntity.from(text)
                : UserMessageEntity.from(text, images);
        context.appendMessage(List.of(message));
        writeAttributes(execution, next -> {
            next.put(KEY_PENDING, List.of());
            next.put(KEY_INJECTED, injectedSnapshot);
            next.put(ReadImageToolExecutor.KEY_CONSUMED, consumed);
        });
        if (!images.isEmpty()) {
            log.info("注入图片: count={}, consumed={}", images.size(), consumed);
        }
        return InterceptorResult.NONE;
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> readPending(Execution execution) {
        Object value = attributes(execution).get(KEY_PENDING);
        if (!(value instanceof List<?> list) || list.isEmpty()) return List.of();
        List<Map<String, Object>> pending = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) pending.add((Map<String, Object>) map);
        }
        return pending;
    }

    private List<String> readInjected(Execution execution) {
        Object value = attributes(execution).get(KEY_INJECTED);
        if (!(value instanceof List<?> list)) return List.of();
        List<String> ids = new ArrayList<>();
        for (Object item : list) {
            if (item != null) ids.add(String.valueOf(item));
        }
        return ids;
    }

    private int readConsumed(Map<String, Object> attributes) {
        Long value = ExecutionAttributes.readLong(attributes, ReadImageToolExecutor.KEY_CONSUMED);
        return value == null ? 0 : value.intValue();
    }

    private static Map<String, Object> attributes(Execution execution) {
        AgentRequest request = execution.getAgentRequest();
        return request == null ? Map.of() : request.runtimeParametersOrDefault().getAttributes();
    }

    /**
     * 运行时属性在请求准备阶段是 {@code Map.copyOf}（不可变），只能整体换一份再挂回去；
     * 换完随执行快照持久化，suspend/resume 不丢。
     */
    private static void writeAttributes(Execution execution, Consumer<Map<String, Object>> mutation) {
        AgentRequest request = execution.getAgentRequest();
        if (request == null) return;
        AgentRuntimeParameters parameters = request.runtimeParametersOrDefault();
        Map<String, Object> next = new HashMap<>(parameters.getAttributes());
        mutation.accept(next);
        parameters.setAttributes(Map.copyOf(next));
        request.setRuntimeParameters(parameters);
    }

    private static String text(Object value) {
        if (value == null) return null;
        String text = String.valueOf(value).trim();
        return text.isEmpty() ? null : text;
    }
}
