package com.summit.dp.shared.utils;

import cn.hutool.core.codec.Base64;
import com.summit.core.agent.Image;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.session.domain.model.SessionMessage;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;

/** 同一位置仍以上传文件优先，地址仅作缺省，避免兼容调用重复发送图片。 */
@Component
@Slf4j
public class ChatImageResolver {
    public List<Image> resolve(List<MultipartFile> imageFiles, List<String> imageUrls) {
        List<MultipartFile> files = imageFiles == null ? List.of() : imageFiles;
        List<String> urls = imageUrls == null ? List.of() : imageUrls;
        int imageCount = 0;
        for (int index = 0; index < Math.max(files.size(), urls.size()); index++) {
            MultipartFile file = index < files.size() ? files.get(index) : null;
            String url = index < urls.size() ? urls.get(index) : null;
            if ((file != null && !file.isEmpty()) || (url != null && !url.isBlank())) imageCount++;
        }
        // 数量先于文件读取校验，超限请求不能进入模型或留下已受理记录。
        throwIf(imageCount > SessionMessage.MAX_IMAGE_COUNT, "每条消息最多上传 " + SessionMessage.MAX_IMAGE_COUNT + " 张图片");
        List<Image> images = new ArrayList<>();
        for (int index = 0; index < Math.max(files.size(), urls.size()); index++) {
            MultipartFile file = index < files.size() ? files.get(index) : null;
            String url = index < urls.size() ? urls.get(index) : null;
            if (file != null && !file.isEmpty()) {
                String mimeType = file.getContentType();
                throwIf(mimeType == null || !mimeType.startsWith("image/"), "只支持上传图片文件");
                try {
                    images.add(Image.from(Base64.encode(file.getBytes()), mimeType));
                } catch (IOException error) {
                    log.error("读取上传图片失败: filename={}", file.getOriginalFilename(), error);
                    throw new ClientException("读取上传图片失败");
                }
            } else if (url != null && !url.isBlank()) {
                images.add(parseAddress(url.trim()));
            }
        }
        return images;
    }

    private Image parseAddress(String address) {
        if (address.startsWith("data:")) {
            int separator = address.indexOf(',');
            throwIf(separator < 0, "图片 Data URL 格式不正确");
            String header = address.substring(5, separator);
            throwIf(!header.startsWith("image/") || !header.endsWith(";base64"), "图片 Data URL 必须使用图片 MIME 类型和 base64 编码");
            String data = address.substring(separator + 1);
            throwIf(data.isBlank(), "图片 Data URL 内容不能为空");
            return Image.from(data, header.substring(0, header.length() - 7));
        }
        if (address.startsWith("http:") || address.startsWith("https:")) {
            URI uri;
            try {
                uri = URI.create(address);
            } catch (IllegalArgumentException error) {
                throw new ClientException("图片地址格式不正确");
            }
            throwIf(uri.getHost() == null, "图片地址必须包含有效主机名");
            return Image.from(uri);
        }
        return Image.from(address);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
