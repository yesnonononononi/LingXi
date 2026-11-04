package com.summit.dp.workflow.infrastructure.tools.image;

import com.summit.core.agent.Execution;
import com.summit.core.agent.Image;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.conversation.message.content.Content;
import com.summit.core.conversation.message.content.ImageContent;
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
import java.util.*;

/** 工具回执仅含元数据，像素须等工具轮提交后再作为用户消息注入。 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ImageInjectionInterceptor implements LoopInterceptor {

    /** 待注入队列：工具执行时写入，下一轮模型调用前消费。 */
    static final String KEY_PENDING = "lingxi.image.pending";

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
            ImageExecutionAttributes.mutate(execution, attributes -> attributes.put(KEY_PENDING, List.copyOf(pending)));
        }
        return InterceptorResult.NONE;
    }

    @Override
    public InterceptorResult onBeforeModelInvoke(LoopContext context) {
        Execution execution = context.getLoopMessages().getExecution();
        List<Map<String, Object>> pending = readPending(execution);
        if (pending.isEmpty()) return InterceptorResult.NONE;

        Map<String, Object> attributes = ImageExecutionAttributes.read(execution);
        Long sessionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.SESSION_ID);
        Set<String> visibleImages = collectVisibleImages(execution.getMessages());
        List<Image> images = new ArrayList<>();
        List<String> lines = new ArrayList<>();

        for (Map<String, Object> entry : pending) {
            String imageId = text(entry.get("imageId"));
            String path = text(entry.get("path"));
            String mimeType = text(entry.get("mimeType"));
            String extension = text(entry.get("ext"));
            if (imageId == null) continue;
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
                String base64 = Base64.getEncoder().encodeToString(Files.readAllBytes(cached));
                if (!visibleImages.add(base64)) {
                    lines.add("- " + path + "：与上下文中的图片相同，不重复提供");
                    continue;
                }
                images.add(Image.from(base64, mimeType));
                lines.add("- " + path + "（" + entry.get("width") + "×" + entry.get("height") + "）");
            } catch (IOException unreadable) {
                log.warn("注入图片失败: imageId={}, path={}", imageId, path, unreadable);
                lines.add("- " + path + "：图片读取失败，请不要臆测内容");
            }
        }

        // 队列必须清空：同一张图不能在后续每一轮重复注入。
        String intro = images.isEmpty()
                ? "以下是 read_image 的结果说明：\n"
                : "以下是上一轮 read_image 的结果，图片内容按上下文窗口保留：\n";
        String text = intro + String.join("\n", lines);
        UserMessageEntity message = images.isEmpty()
                ? UserMessageEntity.from(text)
                : UserMessageEntity.from(text, images);
        context.appendMessage(List.of(message));
        ImageExecutionAttributes.mutate(execution, next -> next.put(KEY_PENDING, List.of()));
        if (!images.isEmpty()) {
            log.info("注入图片: count={}", images.size());
        }
        return InterceptorResult.NONE;
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> readPending(Execution execution) {
        Object value = ImageExecutionAttributes.read(execution).get(KEY_PENDING);
        if (!(value instanceof List<?> list) || list.isEmpty()) return List.of();
        List<Map<String, Object>> pending = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) pending.add((Map<String, Object>) map);
        }
        return pending;
    }

    private Set<String> collectVisibleImages(List<Message> messages) {
        Set<String> images = new HashSet<>();
        for (Message message : messages) {
            if (!(message instanceof UserMessageEntity user)) continue;
            for (Content content : user.getContent()) {
                if (content instanceof ImageContent image) images.add(image.getImage().getBase64Data());
            }
        }
        return images;
    }

    private static String text(Object value) {
        if (value == null) return null;
        String text = String.valueOf(value).trim();
        return text.isEmpty() ? null : text;
    }
}
