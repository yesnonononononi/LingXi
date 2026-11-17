package com.summit.dp.workflow.pending;

import com.summit.dp.workflow.api.controller.ChatController;
import com.summit.dp.workflow.application.chat.ChatService;
import com.summit.dp.workflow.application.pending.PendingAttachmentContent;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpMethod;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 待发送队列三个 REST 的接线契约：单条继续、原地修改、附件读取。
 *
 * <p>这几个都是「路径写错也不会编译报错、前端只会看到 404」的接口，
 * 所以这里钉 URL、HTTP 方法，以及参数是否真的落到 service 上。</p>
 */
class ChatPendingEndpointTest {

    private final ChatService service = mock(ChatService.class);
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new ChatController(service, null)).build();

    @Test
    void confirmOnlyTargetsTheOneMessage() throws Exception {
        mvc.perform(post("/a/completion/42/pending/777/confirm"))
                .andExpect(status().isOk());

        verify(service).confirmPendingCommand(42L, "777");
    }

    @Test
    void updateCarriesTextRetainedIdsAndNewImages() throws Exception {
        mvc.perform(multipart(HttpMethod.PUT, "/a/completion/42/pending/777")
                        .file(new MockMultipartFile("image", "new.png", "image/png", new byte[]{5}))
                        .param("input", "改过的文本")
                        .param("keepAttachmentIds", "a1", "a2"))
                .andExpect(status().isOk());

        ArgumentCaptor<List<String>> kept = ArgumentCaptor.captor();
        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<MultipartFile>> images = ArgumentCaptor.forClass(List.class);
        verify(service).updatePendingCommand(eq(42L), eq("777"), eq("改过的文本"), kept.capture(), images.capture());
        assertEquals(List.of("a1", "a2"), kept.getValue());
        assertEquals(1, images.getValue().size());
        assertEquals("new.png", images.getValue().getFirst().getOriginalFilename());
    }

    /** 表单里没带 {@code keepAttachmentIds} 必须是「附件不动」，不能退化成「全丢」。 */
    @Test
    void omittingKeepIdsMeansKeepThemAll() throws Exception {
        mvc.perform(multipart(HttpMethod.PUT, "/a/completion/42/pending/777").param("input", "只改文字"))
                .andExpect(status().isOk());

        verify(service).updatePendingCommand(eq(42L), eq("777"), eq("只改文字"), isNull(), isNull());
    }

    @Test
    void attachmentIsServedWithItsOwnMime() throws Exception {
        when(service.readPendingAttachment(42L, "777", "a1"))
                .thenReturn(new PendingAttachmentContent("a.png", "image/png", new byte[]{1, 2, 3}));

        mvc.perform(get("/a/completion/42/pending/777/attachments/a1"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("image/png"))
                .andExpect(content().bytes(new byte[]{1, 2, 3}));

        verify(service).readPendingAttachment(42L, "777", "a1");
    }
}
