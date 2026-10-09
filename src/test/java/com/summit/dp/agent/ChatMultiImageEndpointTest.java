package com.summit.dp.agent;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.api.controller.ChatController;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.ChatService;
import com.summit.dp.agent.application.vo.ChatAcceptanceVO;
import com.summit.dp.session.domain.model.SessionMessage;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ChatMultiImageEndpointTest {
    private final ChatService service = mock(ChatService.class);
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new ChatController(service)).build();

    @Test
    void repeatedImagePartsReachTheCommandInUploadOrder() throws Exception {
        when(service.acceptCommand(any())).thenReturn(Result.success(ChatAcceptanceVO.builder().sessionId(42L).turnId(43L).build()));
        mvc.perform(multipart("/a/completion/commands")
                .file(new MockMultipartFile("image", "first.png", "image/png", new byte[]{1}))
                .file(new MockMultipartFile("image", "second.jpg", "image/jpeg", new byte[]{2}))
                .param("input", "比较两张图片").param("sessionId", "42"))
                .andExpect(status().isOk());
        ArgumentCaptor<ChatCommand> command = ArgumentCaptor.forClass(ChatCommand.class);
        verify(service).acceptCommand(command.capture());
        assertEquals(List.of("first.png", "second.jpg"), command.getValue().imageFile().stream().map(file -> file.getOriginalFilename()).toList());
    }

    @Test
    void repeatedImageUrlsReachTheCommandWithoutUploads() throws Exception {
        when(service.acceptCommand(any())).thenReturn(Result.success(ChatAcceptanceVO.builder().sessionId(42L).turnId(43L).build()));
        List<String> urls = List.of("https://example.com/first.png", "https://example.com/second.jpg");
        mvc.perform(multipart("/a/completion/commands").param("input", "比较两张图片")
                .param("sessionId", "42").param("imageUrl", urls.toArray(String[]::new)))
                .andExpect(status().isOk());
        ArgumentCaptor<ChatCommand> command = ArgumentCaptor.forClass(ChatCommand.class);
        verify(service).acceptCommand(command.capture());
        assertEquals(urls, command.getValue().imageUrl());
    }

    @Test
    void exposesTheDomainLimitWithoutDuplicatingItsValue() throws Exception {
        mvc.perform(get("/a/completion/limits"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.maxImages").value(SessionMessage.MAX_IMAGE_COUNT));
    }
}
