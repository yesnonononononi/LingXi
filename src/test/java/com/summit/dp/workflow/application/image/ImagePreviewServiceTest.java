package com.summit.dp.workflow.application.image;

import com.summit.dp.workflow.infrastructure.tools.image.ImageCacheDirectory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 预览读取的解析与内容类型判定：接口层不再自己判这些，这里必须钉住。 */
class ImagePreviewServiceTest {

    @TempDir
    Path dataDir;

    private ImageCacheDirectory cache() {
        return new ImageCacheDirectory(dataDir.toString());
    }

    @Test
    void resolvesTheCachedFileAndItsContentType() throws Exception {
        ImageCacheDirectory cache = this.cache();
        ImagePreviewService service = new ImagePreviewService(cache);
        byte[] png = {1, 2, 3};
        byte[] jpg = {4, 5, 6};

        String pngId = cache.store(42L, png, "png").imageId();
        String jpgId = cache.store(42L, jpg, "jpg").imageId();

        ImagePreview pngPreview = service.preview(42L, pngId, "png").orElseThrow();
        assertEquals(ImagePreview.ContentType.PNG, pngPreview.contentType());
        assertArrayEquals(png, Files.readAllBytes(pngPreview.file()));

        ImagePreview jpgPreview = service.preview(42L, jpgId, "jpg").orElseThrow();
        assertEquals(ImagePreview.ContentType.JPEG, jpgPreview.contentType());
        assertArrayEquals(jpg, Files.readAllBytes(jpgPreview.file()));

        // 扩展名大小写不影响档位判定，也不影响解析。
        assertEquals(ImagePreview.ContentType.PNG, service.preview(42L, pngId, "PNG").orElseThrow().contentType());
        assertTrue(Files.isRegularFile(pngPreview.file()));
    }

    @Test
    void missingOrUnsupportedImagesResolveToEmpty() throws Exception {
        ImageCacheDirectory cache = this.cache();
        ImagePreviewService service = new ImagePreviewService(cache);
        String pngId = cache.store(42L, new byte[]{7}, "png").imageId();

        assertTrue(service.preview(43L, pngId, "png").isEmpty(), "跨会话不得读到别人的缓存");
        assertTrue(service.preview(42L, "0000000000000000", "png").isEmpty(), "不存在的标识");
        assertTrue(service.preview(42L, pngId, "svg").isEmpty(), "缓存只收 png / jpg");
        assertTrue(service.preview(42L, "not-a-hash", "png").isEmpty(), "标识必须是 16 位十六进制");
        assertFalse(service.preview(42L, pngId, "png").isEmpty());
    }
}
