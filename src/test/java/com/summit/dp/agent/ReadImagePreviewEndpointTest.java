package com.summit.dp.agent;

import com.summit.dp.workflow.api.controller.ReadImagePreviewController;
import com.summit.dp.workflow.infrastructure.tools.image.ImageCacheDirectory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.file.Path;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ReadImagePreviewEndpointTest {
    @TempDir
    Path dataDir;

    @Test
    void servesTheExactCachedBytesAndImageMediaType() throws Exception {
        ImageCacheDirectory cache = new ImageCacheDirectory(dataDir.toString());
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ReadImagePreviewController(cache)).build();
        for (String ext : new String[]{"png", "jpg"}) {
            byte[] bytes = new byte[]{1, 2, 3};
            String imageId = cache.store(42L, bytes, ext).imageId();
            mvc.perform(get("/a/images/42/" + imageId + "." + ext)).andExpect(status().isOk())
                    .andExpect(content().bytes(bytes))
                    .andExpect(content().contentType("png".equals(ext) ? MediaType.IMAGE_PNG : MediaType.IMAGE_JPEG))
                    .andExpect(header().string("Cache-Control", "no-store"))
                    .andExpect(header().string("X-Content-Type-Options", "nosniff"));
        }
    }

    @Test
    void missingImagesWrongSessionsAndUnsupportedIdentifiersReturnNotFound() throws Exception {
        ImageCacheDirectory cache = new ImageCacheDirectory(dataDir.toString());
        String imageId = cache.store(42L, new byte[]{4, 5, 6}, "png").imageId();
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ReadImagePreviewController(cache)).build();
        mvc.perform(get("/a/images/43/" + imageId + ".png")).andExpect(status().isNotFound());
        mvc.perform(get("/a/images/42/0000000000000000.png")).andExpect(status().isNotFound());
        mvc.perform(get("/a/images/42/" + imageId + ".svg")).andExpect(status().isNotFound());
        mvc.perform(get("/a/images/42/not-a-hash.png")).andExpect(status().isNotFound());
    }
}
