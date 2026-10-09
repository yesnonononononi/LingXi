package com.summit.dp.session.application.convert;

import com.summit.core.agent.Image;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.conversation.message.content.ImageContent;

import java.util.List;

/** 图片随原始消息保存；展示地址从持久化内容还原，不依赖浏览器临时地址。 */
public final class UserImageViewAssembler {
    private UserImageViewAssembler() {
    }

    public static List<String> resolveImageUrls(UserMessageEntity message) {
        if (message == null || message.getContent() == null) return List.of();
        return message.getContent().stream()
                .filter(content -> content instanceof ImageContent)
                .map(content -> ((ImageContent) content).getImage())
                .map(UserImageViewAssembler::toImageUrl)
                .toList();
    }

    private static String toImageUrl(Image image) {
        return image.getUrl() != null ? image.getUrl().toString()
                : "data:" + image.mimeType() + ";base64," + image.getBase64Data();
    }
}
