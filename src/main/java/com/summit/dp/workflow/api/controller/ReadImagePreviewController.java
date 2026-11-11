package com.summit.dp.workflow.api.controller;

import com.summit.dp.workflow.application.image.ImagePreview;
import com.summit.dp.workflow.application.image.ImagePreviewService;
import lombok.RequiredArgsConstructor;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** 预览只读取规整后的会话缓存，不接受工作区路径；路径解析与内容类型判定在应用层。 */
@RestController
@RequestMapping("/a/images")
@RequiredArgsConstructor
public class ReadImagePreviewController {

    private final ImagePreviewService previews;

    @GetMapping("/{sessionId}/{imageId}.{ext}")
    public ResponseEntity<Resource> preview(@PathVariable long sessionId, @PathVariable String imageId,
                                           @PathVariable String ext) {
        return previews.preview(sessionId, imageId, ext)
                .map(this::body)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** 应用层只给内容类型档位，HTTP 常量在这里落：接口层只做映射，不判别业务。 */
    private ResponseEntity<Resource> body(ImagePreview preview) {
        return ResponseEntity.ok()
                .contentType(preview.contentType() == ImagePreview.ContentType.PNG
                        ? MediaType.IMAGE_PNG : MediaType.IMAGE_JPEG)
                .cacheControl(CacheControl.noStore())
                .header("X-Content-Type-Options", "nosniff")
                .body(new FileSystemResource(preview.file()));
    }
}
