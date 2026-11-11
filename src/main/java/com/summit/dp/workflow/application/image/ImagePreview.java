package com.summit.dp.workflow.application.image;

import java.nio.file.Path;

/**
 * 一张已落盘预览图的读取结果。
 *
 * @param file        缓存里真实存在的文件（已复核仍在会话目录内）
 * @param contentType 内容类型档位；接口层据此映射成具体 MIME，不在这里拼 HTTP 常量
 */
public record ImagePreview(Path file, ContentType contentType) {

    /** 缓存只收 PNG / JPEG 两种，扩展名到档位的判定属于业务口径，不在控制器里做。 */
    public enum ContentType {
        PNG,
        JPEG
    }
}
