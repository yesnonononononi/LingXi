package com.summit.dp.execution;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.workflow.api.controller.ChatController;
import com.summit.dp.workflow.application.chat.ChatService;
import com.summit.dp.workflow.application.resume.ResumeSupplementCommand;
import com.summit.dp.workflow.application.resume.ResumeSupplementService;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ResumeSupplementEndpointTest {
    @Test
    void optionalJsonBodyRoutesToSupplementAdmissionAndEmptyBodyKeepsOrdinaryResume() throws Exception {
        ChatService chat = mock(ChatService.class);
        ResumeSupplementService supplements = mock(ResumeSupplementService.class);
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ChatController(chat, supplements)).build();
        when(chat.resume(500L)).thenReturn(Result.success("完成"));
        mvc.perform(post("/a/completion/500/resume")).andExpect(status().isOk());
        verify(chat).resume(500L);
        ResumeSupplementCommand command = new ResumeSupplementCommand(9007199254740993L,
                "d58322cb-4ef9-4f32-a4cf-1e10bb51b937", "先别提交");
        when(supplements.accept(500L, command)).thenReturn("9007199254740995");
        mvc.perform(post("/a/completion/500/resume").contentType("application/json")
                .content("{\"turnId\":\"9007199254740993\",\"requestId\":\"d58322cb-4ef9-4f32-a4cf-1e10bb51b937\",\"input\":\"先别提交\"}"))
                .andExpect(status().isOk());
        verify(supplements).accept(500L, command);
        verifyNoMoreInteractions(chat);
    }
}
