package com.summit.dp.checklist.infrastructure;

import com.summit.dp.checklist.api.controller.ChecklistController;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import org.junit.jupiter.api.Test;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;
import java.util.Optional;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ChecklistEndpointTest {

    @Test
    void currentEndpointPreservesStringIdsAndExplicitRunningStatus() throws Exception {
        long sessionId = 9007199254740993L;
        ChecklistService service = mock(ChecklistService.class);
        ChecklistVO snapshot = ChecklistVO.builder().checklistId(sessionId + 2).sessionId(sessionId)
                .title("回归验证").status("ACTIVE")
                .steps(List.of(ChecklistVO.StepVO.builder().stepId(sessionId + 4).seq(1)
                        .content("编译").status("IN_PROGRESS").build())).build();
        when(service.findCurrent(sessionId)).thenReturn(Optional.of(snapshot));
        when(service.findCurrent(sessionId + 1)).thenReturn(Optional.empty());
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ChecklistController(service))
                .setMessageConverters(new MappingJackson2HttpMessageConverter(new JsonConfig().objectMapper())).build();
        mvc.perform(get("/checklist/current").param("sessionId", Long.toString(sessionId)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.sessionId").value(Long.toString(sessionId)))
                .andExpect(jsonPath("$.data.checklistId").value(Long.toString(sessionId + 2)))
                .andExpect(jsonPath("$.data.steps[0].stepId").value(Long.toString(sessionId + 4)))
                .andExpect(jsonPath("$.data.steps[0].seq").value(1))
                .andExpect(jsonPath("$.data.steps[0].status").value("IN_PROGRESS"));
        mvc.perform(get("/checklist/current").param("sessionId", Long.toString(sessionId + 1)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data").doesNotExist());
        verify(service).findCurrent(sessionId + 1);
    }

    @Test
    void latestEndpointServesDeletedHistoryForAuditing() throws Exception {
        long sessionId = 9007199254740993L;
        ChecklistService service = mock(ChecklistService.class);
        ChecklistVO deleted = ChecklistVO.builder().checklistId(sessionId + 2).sessionId(sessionId)
                .title("已收尾").status("DELETED")
                .steps(List.of(ChecklistVO.StepVO.builder().stepId(sessionId + 4).seq(1)
                        .content("编译").status("COMPLETED").build())).build();
        when(service.findLatestForDisplay(sessionId)).thenReturn(Optional.of(deleted));
        when(service.findLatestForDisplay(sessionId + 1)).thenReturn(Optional.empty());
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ChecklistController(service))
                .setMessageConverters(new MappingJackson2HttpMessageConverter(new JsonConfig().objectMapper())).build();

        mvc.perform(get("/checklist/latest").param("sessionId", Long.toString(sessionId)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("DELETED"))
                .andExpect(jsonPath("$.data.checklistId").value(Long.toString(sessionId + 2)))
                .andExpect(jsonPath("$.data.steps[0].status").value("COMPLETED"));
        mvc.perform(get("/checklist/latest").param("sessionId", Long.toString(sessionId + 1)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data").doesNotExist());
        verify(service).findLatestForDisplay(sessionId + 1);
    }
}
