package com.summit.dp.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpSession;
import com.summit.dp.mcp.api.controller.McpController;
import com.summit.dp.mcp.application.service.McpConfigAssembler;
import com.summit.dp.mcp.application.service.impl.McpServiceImpl;
import com.summit.dp.mcp.application.service.impl.McpValidator;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.mcp.infrastructure.McpManager;
import com.summit.dp.shared.config.GlobalExceptionHandler;
import mcp.McpSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 连接测试端点的契约：一次性会话、只读服务端工具名、失败不外泄凭据。 */
class McpConnectTest {

    private final McpRepository repository = mock(McpRepository.class);
    private final ObjectMapper mapper = new ObjectMapper();
    private McpManager manager;
    private McpSessionFactory realFactory;

    @AfterEach
    void closeRealFactory() {
        if (realFactory != null) realFactory.close();
        if (manager != null) manager.close();
    }

    private MockMvc endpoint(McpSessionFactory factory) {
        McpConfigAssembler assembler = new McpConfigAssembler();
        manager = new McpManager(repository, assembler, factory);
        McpServiceImpl service = new McpServiceImpl(repository, new McpValidator(repository), assembler, manager);
        return MockMvcBuilders.standaloneSetup(new McpController(service))
                .setControllerAdvice(new GlobalExceptionHandler()).build();
    }

    /** 真连接用例统一走这个入口，测试结束由 {@link #closeRealFactory()} 释放连接。 */
    private MockMvc realEndpoint() {
        realFactory = McpSessionFactoryFixture.realFactory(mapper);
        return endpoint(realFactory);
    }

    @Test
    void draftConnectionReturnsServerToolNamesClosesSessionAndDoesNotPublishOrPersist() throws Exception {
        McpSessionFactory factory = mock(McpSessionFactory.class);
        McpSession session = mock(McpSession.class);
        when(factory.openSession(any(McpConfig.MCP.class))).thenReturn(session);
        when(session.serverToolNames()).thenReturn(List.of("echo"));
        endpoint(factory).perform(post("/mcp/connect").contentType(APPLICATION_JSON)
                        .content("{\"name\":\"draft\",\"transport\":\"streamable-http\",\"url\":\"http://localhost:9999/mcp\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(1))
                .andExpect(jsonPath("$.data.toolCount").value(1))
                .andExpect(jsonPath("$.data.toolNames[0]").value("echo"))
                .andExpect(jsonPath("$.data.elapsedMillis").isNumber());
        verify(session).close();
        // 连接测试只读服务端声明的名字，既不拉取本地前缀的工具定义，更不可能执行工具。
        verify(session, never()).tools();
        verifyNoInteractions(repository);
        McpConfig config = new McpConfig();
        config.setMcp(List.of(new McpConfig.MCP("draft", null, null, null, 1000)));
        assertTrue(manager.openScope(config).isEmpty());
    }

    @Test
    void invalidConfigurationReturnsBusinessErrorWithoutOpeningConnection() throws Exception {
        McpSessionFactory factory = mock(McpSessionFactory.class);
        endpoint(factory).perform(post("/mcp/connect").contentType(APPLICATION_JSON)
                        .content("{\"name\":\"draft\",\"transport\":\"stdio\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.errMsg").value("stdio 启动命令不能为空"));
        verifyNoInteractions(factory, repository);
    }

    @Test
    void failedDiscoveryClosesSessionAndDoesNotExposeCredentials() throws Exception {
        McpSessionFactory factory = mock(McpSessionFactory.class);
        McpSession session = mock(McpSession.class);
        when(factory.openSession(any(McpConfig.MCP.class))).thenReturn(session);
        when(session.serverToolNames()).thenThrow(new IllegalStateException("Authorization: secret-token"));
        String response = endpoint(factory).perform(post("/mcp/connect").contentType(APPLICATION_JSON)
                        .content("{\"name\":\"draft\",\"url\":\"http://localhost:9999/mcp\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(0))
                .andReturn().getResponse().getContentAsString();
        assertFalse(response.contains("secret-token"));
        verify(session).close();
        verifyNoInteractions(repository);
    }

    @Test
    void realStdioClientCompletesHandshakeAndDiscoversToolThroughHttpEndpoint() throws Exception {
        String python = System.getProperty("mcp.test.python", "python");
        String fixture = Path.of("src/test/resources/mcp/connect_server.py").toAbsolutePath().toString();
        String payload = mapper.writeValueAsString(Map.of("name", "stdio-fixture", "transport", "stdio",
                "command", List.of(python, "-u", fixture), "env", Map.of("MCP_TEST_TOOL", "environment_echo"),
                "initializationTimeout", 5000, "executionTimeout", 5000));
        realEndpoint().perform(post("/mcp/connect").contentType(APPLICATION_JSON).content(payload))
                .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(1))
                .andExpect(jsonPath("$.data.toolNames[0]").value("environment_echo"));
        verifyNoInteractions(repository);
    }

    @Test
    void realHttpClientCompletesHandshakeWithHeadersAndDiscoversTools() throws Exception {
        try (McpHttpFixture fixture = new McpHttpFixture("Bearer test-token")) {
            String payload = mapper.writeValueAsString(Map.of("name", "http-fixture", "transport", "streamable-http",
                    "url", fixture.url(), "headers", Map.of("Authorization", "Bearer test-token"),
                    "initializationTimeout", 5000, "executionTimeout", 5000));
            realEndpoint().perform(post("/mcp/connect").contentType(APPLICATION_JSON).content(payload))
                    .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(1))
                    .andExpect(jsonPath("$.data.toolNames[0]").value("http_echo"));
            verifyNoInteractions(repository);
        }
    }

    @Test
    void realStdioFailureIsReportedByEndpoint() throws Exception {
        String python = System.getProperty("mcp.test.python", "python");
        String payload = mapper.writeValueAsString(Map.of("name", "failed-fixture", "transport", "stdio",
                "command", List.of(python, "-c", "raise SystemExit(1)"),
                "initializationTimeout", 300, "executionTimeout", 300));
        JsonNode result = mapper.readTree(realEndpoint().perform(post("/mcp/connect")
                        .contentType(APPLICATION_JSON).content(payload)).andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString());
        assertEquals(0, result.path("code").asInt());
        assertTrue(result.path("errMsg").asText().contains("连接测试失败"));
        verifyNoInteractions(repository);
    }
}
