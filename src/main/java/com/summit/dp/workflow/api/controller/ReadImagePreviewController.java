package com.summit.dp.workflow.api.controller;

import com.summit.dp.workflow.infrastructure.tools.image.ImageCacheDirectory;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Path;

/** 预览只读取规整后的会话缓存，不接受工作区路径。 */
@RestController
@RequestMapping("/a/images")
public class ReadImagePreviewController {
    private final ImageCacheDirectory cache;

    public ReadImagePreviewController(ImageCacheDirectory cache) {
        this.cache = cache;
    }

    @GetMapping("/{sessionId}/{imageId}.{ext}")
    public ResponseEntity<Resource> preview(@PathVariable long sessionId, @PathVariable String imageId,
                                           @PathVariable String ext) {
        Path image = cache.resolve(sessionId, imageId, ext);
        if (image == null) return ResponseEntity.notFound().build();
        MediaType contentType = "png".equalsIgnoreCase(ext) ? MediaType.IMAGE_PNG : MediaType.IMAGE_JPEG;
        return ResponseEntity.ok().contentType(contentType).cacheControl(CacheControl.noStore())
                .header("X-Content-Type-Options", "nosniff").body(new FileSystemResource(image));
    }
}
