package com.summit.dp.sandbox_security;

import com.summit.dp.sandbox_security.api.SecurityRuleController;
import com.summit.dp.sandbox_security.application.SecurityRulePresets;
import com.summit.dp.sandbox_security.application.SecurityRuleService;
import com.summit.dp.sandbox_security.domain.model.SecurityCategory;
import com.summit.dp.sandbox_security.infrastructure.repository.JsonSecurityRuleRepository;
import com.summit.dp.shared.config.GlobalExceptionHandler;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import java.nio.file.Path;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class SecurityRuleApiTest {
    @TempDir Path root;
    private MockMvc mvc() {
        SecurityRuleService service = new SecurityRuleService(
                new JsonSecurityRuleRepository(root.resolve("files.json"), () -> SecurityRulePresets.defaults(SecurityCategory.FILES)),
                new JsonSecurityRuleRepository(root.resolve("terminal.json"), () -> SecurityRulePresets.defaults(SecurityCategory.TERMINAL)),
                new JsonSecurityRuleRepository(root.resolve("net.json"), () -> SecurityRulePresets.defaults(SecurityCategory.NET)));
        return MockMvcBuilders.standaloneSetup(new SecurityRuleController(service))
                .setControllerAdvice(new GlobalExceptionHandler())
                .setMessageConverters(new MappingJackson2HttpMessageConverter(new JsonConfig().objectMapper())).build();
    }
    @Test void productionMapperUsesStringRevisionsAndRoundTripsTheLocalTable() throws Exception {
        MockMvc mvc = mvc();
        mvc.perform(get("/sandbox/security/files")).andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(1)).andExpect(jsonPath("$.data.revision").value("0"))
                .andExpect(jsonPath("$.data.activation").value("NATIVE_NEXT_WORKSPACE"));
        mvc.perform(put("/sandbox/security/files").contentType(MediaType.APPLICATION_JSON)
                .content("{\"revision\":\"0\",\"rules\":[]}"))
                .andExpect(jsonPath("$.code").value(1)).andExpect(jsonPath("$.data.revision").value("1"));
        mvc().perform(get("/sandbox/security/files")).andExpect(jsonPath("$.data.revision").value("1"))
                .andExpect(jsonPath("$.data.rules.length()").value(0));
        mvc.perform(put("/sandbox/security/files").contentType(MediaType.APPLICATION_JSON)
                .content("{\"revision\":\"0\",\"rules\":[]}"))
                .andExpect(jsonPath("$.code").value(0));
    }
    @Test void networkAndDefaultsExposeRealCapabilitiesWithoutChangingTheTable() throws Exception {
        MockMvc mvc = mvc();
        mvc.perform(get("/sandbox/security/net")).andExpect(jsonPath("$.data.activation").value("OUTBOUND_OPEN"))
                .andExpect(jsonPath("$.data.rules[0].action").value("ALLOW"));
        mvc.perform(post("/sandbox/security/terminal/defaults")).andExpect(jsonPath("$.data.length()").value(6));
        mvc.perform(get("/sandbox/security/terminal")).andExpect(jsonPath("$.data.revision").value("0"))
                .andExpect(jsonPath("$.data.activation").value("IMMEDIATE"));
    }
}
