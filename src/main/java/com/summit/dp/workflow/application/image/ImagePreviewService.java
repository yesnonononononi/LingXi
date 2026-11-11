package com.summit.dp.workflow.application.image;

import com.summit.dp.workflow.infrastructure.tools.image.ImageCacheDirectory;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.util.Locale;
import java.util.Optional;

/**
 * 预览图读取：把「缓存标识 → 真实文件」的解析与内容类型判定收在应用层。
 *
 * <p><b>为什么不让控制器自己调缓存目录</b>：{@code ImageCacheDirectory} 是基础设施实现，
 * 接口层直接注入它，等于把「缓存目录长什么样、扩展名怎么校验」写进了 HTTP 契约里。
 * 缓存布局一变（换目录结构、换存储），接口层就得跟着改；而这里只对外承诺一件事：
 * 给一组标识，要么拿到真实文件与内容类型，要么什么也没有。</p>
 *
 * <p>缓存目录本身仍被生成图、读图、截图注入等多处使用，因此<b>不上提成应用端口</b>：
 * 那会让这四处一起改签名，为的只是让一个只读接口好看一点。</p>
 */
@Service
@RequiredArgsConstructor
public class ImagePreviewService {

    private final ImageCacheDirectory cache;

    /**
     * 读取一张缓存图。
     *
     * @param sessionId 会话 ID（缓存按会话分目录）
     * @param imageId   内容哈希前 16 位
     * @param extension 扩展名；只接受 png / jpg，其余一律视为不存在
     * @return 命中时的真实文件与内容类型；未命中返回空（对外即 404）
     */
    public Optional<ImagePreview> preview(long sessionId, String imageId, String extension) {
        Path file = cache.resolve(sessionId, imageId, extension);
        if (file == null) {
            return Optional.empty();
        }
        return Optional.of(new ImagePreview(file, this.contentType(extension)));
    }

    /** 缓存只收两种：png 之外一律按 JPEG 处理（与落盘时的扩展名集合一致）。 */
    private ImagePreview.ContentType contentType(String extension) {
        return "png".equals(extension.toLowerCase(Locale.ROOT))
                ? ImagePreview.ContentType.PNG : ImagePreview.ContentType.JPEG;
    }
}
