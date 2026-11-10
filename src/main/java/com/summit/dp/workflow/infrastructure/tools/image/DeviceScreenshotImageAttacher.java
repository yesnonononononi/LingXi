package com.summit.dp.workflow.infrastructure.tools.image;

import com.summit.dp.device.application.model.DeviceScreenshot;
import com.summit.dp.device.application.port.ObserveImageAttacher;
import com.summit.dp.execution.ExecutionAttributes;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

/**
 * 设备截图 → 会话图片缓存。
 *
 * <p>设备端把图以 base64 传回来，但工具回执只能放文本；像素要靠
 * {@link ImageInjectionInterceptor} 在下一轮模型调用前作为用户消息注入。所以这里做两件事：
 * 落盘到会话图片缓存（复用 read_image 的缓存与预览通路），并交出一份注入元数据。</p>
 *
 * <p><b>为什么不像 read_image 那样做格式规整</b>：设备截图已经是 JPEG，
 * 再解一次码只是多花 CPU 与内存。缓存目录只认 png/jpg 扩展名，这里按 mimeType 映射。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class DeviceScreenshotImageAttacher implements ObserveImageAttacher {

    private final ImageCacheDirectory cache;

    @Override
    public Optional<Map<String, Object>> attach(Map<String, Object> executionAttributes,
                                               DeviceScreenshot screenshot,
                                               String label) {
        if (screenshot == null || !screenshot.hasPixels()) {
            return Optional.empty();
        }
        // 没有视觉模型时不必落盘：模型看不到图，凭空写一堆文件只会污染缓存
        if (executionAttributes == null
                || !Boolean.TRUE.equals(executionAttributes.get(ExecutionAttributes.MODEL_VISION))) {
            return Optional.empty();
        }
        Long sessionId = ExecutionAttributes.readLong(executionAttributes, ExecutionAttributes.SESSION_ID);
        if (sessionId == null) {
            // 会话归属缺失时宁可不上图：注入侧同样需要它定位缓存，硬塞只会得到一条"图片不可用"
            return Optional.empty();
        }
        try {
            ImageCacheDirectory.CachedImage cached =
                    cache.store(sessionId, screenshot.image(), screenshot.extension());
            return Optional.of(metadata(cached, screenshot, label));
        } catch (IOException storeFailed) {
            log.warn("设备截图落盘失败: label={}, reason={}", label, storeFailed.getMessage());
            return Optional.empty();
        }
    }

    private Map<String, Object> metadata(ImageCacheDirectory.CachedImage cached,
                                         DeviceScreenshot screenshot, String label) {
        Map<String, Object> metadata = new HashMap<>();
        metadata.put("imageId", cached.imageId());
        metadata.put("ext", screenshot.extension());
        metadata.put("mimeType", screenshot.mimeType());
        metadata.put("width", screenshot.width());
        metadata.put("height", screenshot.height());
        metadata.put("path", label);
        return Map.copyOf(metadata);
    }
}
