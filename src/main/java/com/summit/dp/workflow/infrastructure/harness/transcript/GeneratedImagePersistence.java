package com.summit.dp.workflow.infrastructure.harness.transcript;

import com.summit.core.agent.Image;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.infrastructure.tools.image.ImageCacheDirectory;
import com.summit.dp.workflow.infrastructure.tools.image.ImageFormat;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/** 图片先落盘再记录消息，历史和执行快照只保留可查询的地址。 */
@Component
@RequiredArgsConstructor
public class GeneratedImagePersistence {
    private final ImageCacheDirectory cache;

    public void persist(long sessionId, AiMessageEntity message) {
        if (message == null || message.getImages() == null || message.getImages().isEmpty()) return;
        List<Image> images = new ArrayList<>();
        for (Image image : message.getImages()) {
            if (image.getBase64Data() == null || image.getBase64Data().isBlank()) {
                throwIf(image.getUrl() == null, "生图模型未返回图片数据或图片地址");
                images.add(image);
                continue;
            }
            byte[] bytes;
            try { bytes = Base64.getDecoder().decode(image.getBase64Data()); }
            catch (IllegalArgumentException error) { throw new ClientException("生图模型返回的图片编码无法识别"); }
            ImageFormat format = ImageFormat.detect(bytes);
            throwIf(format != ImageFormat.PNG && format != ImageFormat.JPEG, "生图结果必须为 PNG 或 JPEG 图片");
            try {
                ImageCacheDirectory.CachedImage stored = cache.store(sessionId, bytes, format.storedExtension());
                images.add(Image.builder().url(URI.create("/a/images/" + sessionId + "/" + stored.imageId() + "." + format.storedExtension()))
                        .mimeType(format.mimeType()).revisedPrompt(image.getRevisedPrompt()).build());
            } catch (IOException error) {
                throw new ClientException("保存生图结果失败，请检查数据目录是否可写");
            }
        }
        message.setImages(List.copyOf(images));
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
