package com.summit.dp.personalization;

import com.summit.dp.personalization.api.controller.PersonalizationController;
import com.summit.dp.personalization.application.command.PersonalizationCommand;
import com.summit.dp.personalization.application.service.impl.PersonalizationServiceImpl;
import com.summit.dp.personalization.infrastructure.repository.PersonalizationRepositoryImpl;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class PersonalizationApiTest {
    @TempDir Path directory;

    @Test
    void currentCreatesRealRecordAndOptionsExposeSubmissionValues() throws Exception {
        Path path = directory.resolve("blank-machine/config/personalization.json");
        assertFalse(Files.exists(path.getParent()));
        PersonalizationServiceImpl service = new PersonalizationServiceImpl(new PersonalizationRepositoryImpl(path.toString()));
        MockMvc mvc = createMvc(service);
        mvc.perform(get("/personalization/current")).andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value("1"))
                .andExpect(jsonPath("$.data.replyStyle").value("DEFAULT"))
                .andExpect(jsonPath("$.data.title").value(""))
                .andExpect(jsonPath("$.data.commonAgentName").value(""))
                .andExpect(jsonPath("$.data.customInstruction").value(""));
        assertTrue(Files.exists(path));
        PersonalizationRepositoryImpl reopened = new PersonalizationRepositoryImpl(path.toString());
        assertEquals(1, reopened.queryByPage(1, 10).getTotal());
        createMvc(new PersonalizationServiceImpl(reopened)).perform(get("/personalization/current"))
                .andExpect(jsonPath("$.data.id").value("1"))
                .andExpect(jsonPath("$.data.replyStyle").value("DEFAULT"));
        assertEquals(1, reopened.queryByPage(1, 10).getTotal());
        mvc.perform(get("/personalization/reply-styles")).andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].value").value("DEFAULT"))
                .andExpect(jsonPath("$.data[1].value").value("PROFESSIONAL_STRICT"))
                .andExpect(jsonPath("$.data[1].label").value("专业严谨"));
    }

    @Test
    void saveReloadAndClearAllOptionalFieldsThroughHttp() throws Exception {
        Path path = directory.resolve("personalization.json");
        PersonalizationServiceImpl service = new PersonalizationServiceImpl(new PersonalizationRepositoryImpl(path.toString()));
        service.current();
        MockMvc mvc = createMvc(service);
        mvc.perform(post("/personalization/update").contentType(MediaType.APPLICATION_JSON)
                .content("{\"id\":\"1\",\"title\":\"小林\",\"commonAgentName\":\"灵犀\",\"replyStyle\":\"DIRECT\",\"customInstruction\":\"先给结论\\n再解释\"}"))
                .andExpect(jsonPath("$.code").value(1));
        MockMvc reopened = createMvc(new PersonalizationServiceImpl(new PersonalizationRepositoryImpl(path.toString())));
        reopened.perform(get("/personalization/current"))
                .andExpect(jsonPath("$.data.title").value("小林"))
                .andExpect(jsonPath("$.data.commonAgentName").value("灵犀"))
                .andExpect(jsonPath("$.data.replyStyle").value("DIRECT"))
                .andExpect(jsonPath("$.data.customInstruction").value("先给结论\n再解释"));
        mvc.perform(post("/personalization/update").contentType(MediaType.APPLICATION_JSON)
                .content("{\"id\":\"1\",\"title\":\"\",\"commonAgentName\":\"\",\"customInstruction\":\"\"}"))
                .andExpect(jsonPath("$.code").value(1));
        reopened.perform(get("/personalization/current"))
                .andExpect(jsonPath("$.data.title").value(""))
                .andExpect(jsonPath("$.data.commonAgentName").value(""))
                .andExpect(jsonPath("$.data.customInstruction").value(""))
                .andExpect(jsonPath("$.data.replyStyle").value("DIRECT"));
    }

    @Test
    void invalidStyleDoesNotPersistOtherChanges() throws Exception {
        Path path = directory.resolve("personalization.json");
        PersonalizationServiceImpl service = new PersonalizationServiceImpl(new PersonalizationRepositoryImpl(path.toString()));
        service.current();
        String before = Files.readString(path);
        assertThrows(ClientException.class, () -> service.update(PersonalizationCommand.builder()
                .id(1L).title("未保存").replyStyle("invalid").build()));
        assertEquals(before, Files.readString(path));
        assertThrows(ClientException.class, () -> service.update(null));
        assertThrows(ClientException.class, () -> service.findById(null));
    }

    private MockMvc createMvc(PersonalizationServiceImpl service) {
        return MockMvcBuilders.standaloneSetup(new PersonalizationController(service))
                .setMessageConverters(new MappingJackson2HttpMessageConverter(new JsonConfig().objectMapper())).build();
    }
}
