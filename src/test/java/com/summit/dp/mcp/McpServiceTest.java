package com.summit.dp.mcp;

import com.summit.core.conf.McpConfig;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.mcp.api.controller.McpController;
import com.summit.dp.mcp.api.request.McpRequest;
import com.summit.dp.mcp.application.command.McpCommand;
import com.summit.dp.mcp.application.service.impl.McpServiceImpl;
import com.summit.dp.mcp.application.service.impl.McpValidator;
import com.summit.dp.mcp.application.vo.McpVO;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * MCP 模块核心能力单测。
 *
 * <p>聚焦三处对外契约，它们决定了"管理端配置"能否正确变成"模型可见工具"：</p>
 * <ol>
 *   <li><b>凭据脱敏往返</b>：查询出口必须脱敏，且未改动的脱敏值回传时必须还原为库中原值——
 *       否则「打开表单直接保存」会把真实令牌写成掩码串，服务随即 401；</li>
 *   <li><b>currentConfig 装配</b>：字段需逐一映射到框架侧 {@code McpConfig.MCP}，
 *       且无启用项时返回 {@code null}（框架按无 MCP 处理）；</li>
 *   <li><b>校验与状态语义</b>：非法入参被拦截，启停只改 status。</li>
 * </ol>
 */
class McpServiceTest {

    private static final String TOKEN = "Bearer real-secret-token";

    private McpRepository repository() {
        return mock(McpRepository.class);
    }

    private McpServiceImpl service(McpRepository repository) {
        McpServiceImpl impl = new McpServiceImpl(repository, new McpValidator(repository));
        return impl;
    }

    private Mcp sampleModel() {
        return Mcp.builder()
                .id(1L)
                .name("github")
                .transport(Mcp.TRANSPORT_STREAMABLE_HTTP)
                .url("https://api.githubcopilot.com/mcp/")
                .headers(Map.of("Authorization", TOKEN))
                .toolNamePrefix("gh_")
                .initializationTimeout(Duration.ofSeconds(30))
                .executionTimeout(Duration.ofSeconds(60))
                .maxOutput(20000)
                .status(Mcp.STATUS_ENABLED)
                .build();
    }

    /* ---------------- 凭据脱敏 ---------------- */

    @Test
    @DisplayName("查询出口把请求头值替换为掩码，不泄漏令牌")
    void findByIdMasksHeaderValues() {
        McpRepository repository = repository();
        when(repository.findById(1L)).thenReturn(Optional.of(sampleModel()));

        Result<McpVO> result = service(repository).findById(1L);

        assertNull(result.getErrMsg(), "成功路径不应带错误信息: " + result.getErrMsg());
        Map<String, String> headers = result.getData().getHeaders();
        assertEquals(1, headers.size());
        assertTrue(headers.containsKey("Authorization"), "头的名称应保留，前端据此展示「已配置」");
        assertEquals(McpVO.MASKED_VALUE, headers.get("Authorization"));
        assertFalse(headers.containsValue(TOKEN), "令牌绝不出现在视图层");
    }

    @Test
    @DisplayName("回传脱敏值时保留库中原令牌——表单「打开即保存」不会把令牌写成掩码")
    void updateWithMaskedValueKeepsOriginalSecret() {
        McpRepository repository = repository();
        when(repository.findById(1L)).thenReturn(Optional.of(sampleModel()));
        when(repository.findByName("github")).thenReturn(Optional.of(sampleModel()));

        McpCommand command = new McpCommand();
        command.setId(1L);
        // 前端把查出来的脱敏值原样提交
        command.setHeaders(Map.of("Authorization", McpVO.MASKED_VALUE));

        Result<Void> result = service(repository).update(command);

        assertNull(result.getErrMsg(), "成功路径不应带错误信息: " + result.getErrMsg());
        ArgumentCaptor<Mcp> captor = ArgumentCaptor.forClass(Mcp.class);
        verify(repository).updateById(captor.capture());
        assertEquals(TOKEN, captor.getValue().getHeaders().get("Authorization"),
                "掩码必须被还原为库中原值");
    }

    @Test
    @DisplayName("显式传入新值则覆盖原令牌，支持真正轮换凭据")
    void updateWithNewValueOverridesSecret() {
        McpRepository repository = repository();
        when(repository.findById(1L)).thenReturn(Optional.of(sampleModel()));
        when(repository.findByName("github")).thenReturn(Optional.of(sampleModel()));

        McpCommand command = new McpCommand();
        command.setId(1L);
        command.setHeaders(Map.of("Authorization", "Bearer rotated-token"));

        service(repository).update(command);

        ArgumentCaptor<Mcp> captor = ArgumentCaptor.forClass(Mcp.class);
        verify(repository).updateById(captor.capture());
        assertEquals("Bearer rotated-token", captor.getValue().getHeaders().get("Authorization"));
    }

    @Test
    @DisplayName("脱敏值对应的头在库中不存在时被丢弃，不写入掩码串")
    void maskedValueWithoutOriginalIsDropped() {
        McpRepository repository = repository();
        Mcp modelWithoutHeaders = Mcp.builder()
                .id(2L).name("fs").transport(Mcp.TRANSPORT_SSE).url("https://x/mcp/")
                .headers(Map.of()).status(Mcp.STATUS_ENABLED).build();
        when(repository.findById(2L)).thenReturn(Optional.of(modelWithoutHeaders));
        when(repository.findByName("fs")).thenReturn(Optional.of(modelWithoutHeaders));

        McpCommand command = new McpCommand();
        command.setId(2L);
        command.setHeaders(Map.of("X-Ghost", McpVO.MASKED_VALUE));

        service(repository).update(command);

        ArgumentCaptor<Mcp> captor = ArgumentCaptor.forClass(Mcp.class);
        verify(repository).updateById(captor.capture());
        assertTrue(captor.getValue().getHeaders().isEmpty(), "凭空出现的掩码头不应落库");
    }

    /* ---------------- 框架侧装配 ---------------- */

    @Test
    @DisplayName("currentConfig 把启用项逐字段映射为框架侧 McpConfig.MCP")
    void currentConfigMapsEveryFieldToFrameworkRecord() {
        McpRepository repository = repository();
        when(repository.findEnabled()).thenReturn(List.of(sampleModel()));

        McpConfig config = service(repository).currentConfig();

        assertEquals(1, config.getMcp().size());
        McpConfig.MCP mcp = config.getMcp().getFirst();
        assertEquals("github", mcp.name());
        assertEquals(Mcp.TRANSPORT_STREAMABLE_HTTP, mcp.transport());
        assertEquals("https://api.githubcopilot.com/mcp/", mcp.url());
        // 下行给框架的是真实令牌，框架需要它才能连上服务
        assertEquals(TOKEN, mcp.headers().get("Authorization"));
        assertEquals("gh_", mcp.toolNamePrefix());
        assertEquals(Duration.ofSeconds(30), mcp.initializationTimeout());
        assertEquals(Duration.ofSeconds(60), mcp.executionTimeout());
        assertEquals(20000, mcp.maxOutput());
    }

    @Test
    @DisplayName("无启用服务时 currentConfig 返回 null，框架按无 MCP 处理")
    void currentConfigReturnsNullWhenNothingEnabled() {
        McpRepository repository = repository();
        when(repository.findEnabled()).thenReturn(List.of());

        assertNull(service(repository).currentConfig());
    }

    @Test
    @DisplayName("headers 为空的启用项仍能装配，不抛异常")
    void currentConfigToleratesNullHeaders() {
        McpRepository repository = repository();
        Mcp noHeaders = Mcp.builder()
                .id(3L).name("bare").transport(Mcp.TRANSPORT_STREAMABLE_HTTP)
                .url("https://bare/mcp/").headers(null)
                .initializationTimeout(Duration.ofSeconds(10))
                .executionTimeout(Duration.ofSeconds(20))
                .maxOutput(1000)
                .status(Mcp.STATUS_ENABLED).build();
        when(repository.findEnabled()).thenReturn(List.of(noHeaders));

        McpConfig config = service(repository).currentConfig();

        assertTrue(config.getMcp().getFirst().headers().isEmpty());
    }

    /* ---------------- 校验与状态 ---------------- */

    @Test
    @DisplayName("重名新增被拒绝，且不落库")
    void addRejectsDuplicateName() {
        McpRepository repository = repository();
        when(repository.findByName("github")).thenReturn(Optional.of(sampleModel()));

        McpCommand command = new McpCommand();
        command.setName("github");
        command.setTransport(Mcp.TRANSPORT_STREAMABLE_HTTP);
        command.setUrl("https://dup/mcp/");

        ClientException e = assertThrows(ClientException.class,
                () -> service(repository).add(command));

        assertTrue(e.getMessage().contains("已存在"), "错误信息应说明重名: " + e.getMessage());
        verify(repository, never()).save(any());
    }

    @Test
    @DisplayName("非 http(s) 地址被拒绝")
    void addRejectsNonHttpUrl() {
        McpRepository repository = repository();

        McpCommand command = new McpCommand();
        command.setName("bad");
        command.setTransport(Mcp.TRANSPORT_SSE);
        command.setUrl("ftp://example.com/mcp");

        ClientException e = assertThrows(ClientException.class,
                () -> service(repository).add(command));

        assertTrue(e.getMessage().contains("http"), "错误信息应说明地址协议要求: " + e.getMessage());
        verify(repository, never()).save(any());
    }

    @Test
    @DisplayName("不支持的传输方式被拒绝")
    void addRejectsUnknownTransport() {
        McpRepository repository = repository();

        McpCommand command = new McpCommand();
        command.setName("x");
        command.setTransport("websocket");
        command.setUrl("https://example.com/mcp");

        ClientException e = assertThrows(ClientException.class,
                () -> service(repository).add(command));

        assertTrue(e.getMessage().contains("传输方式"), "错误信息应说明传输方式非法: " + e.getMessage());
        verify(repository, never()).save(any());
    }

    @Test
    @DisplayName("新增缺省填充默认传输方式、超时与输出上限，并默认启用")
    void addFillsDefaults() {
        McpRepository repository = repository();

        McpCommand command = new McpCommand();
        command.setName("newone");
        command.setTransport(Mcp.TRANSPORT_STREAMABLE_HTTP);
        command.setUrl("https://new/mcp/");

        Result<Void> result = service(repository).add(command);

        assertNull(result.getErrMsg(), "成功路径不应带错误信息: " + result.getErrMsg());
        ArgumentCaptor<Mcp> captor = ArgumentCaptor.forClass(Mcp.class);
        verify(repository).save(captor.capture());
        Mcp saved = captor.getValue();
        assertEquals(Mcp.DEFAULT_INITIALIZATION_TIMEOUT, saved.getInitializationTimeout());
        assertEquals(Mcp.DEFAULT_EXECUTION_TIMEOUT, saved.getExecutionTimeout());
        assertEquals(Mcp.DEFAULT_MAX_OUTPUT, saved.getMaxOutput());
        assertEquals(Mcp.STATUS_ENABLED, saved.getStatus());
    }

    @Test
    @DisplayName("停用状态可被正确判定")
    void disabledStatusIsNotEnabled() {
        Mcp disabled = Mcp.builder().id(9L).name("off").status(Mcp.STATUS_DISABLED).build();
        assertFalse(disabled.enabled());

        disabled.changeEnabled(true);
        assertTrue(disabled.enabled());
    }

    @Test
    @DisplayName("Controller 平移全部字段到 Command，不漏 headers 与超时")
    void controllerCopiesAllFieldsToCommand() {
        McpRepository repository = repository();
        McpServiceImpl impl = service(repository);
        McpController controller = new McpController(impl);

        McpRequest request = new McpRequest();
        request.setId(5L);
        request.setName("gh");
        request.setTransport(Mcp.TRANSPORT_SSE);
        request.setUrl("https://gh/mcp/");
        request.setHeaders(Map.of("Authorization", "Bearer t"));
        request.setToolNamePrefix("g_");
        request.setInitializationTimeout(5000L);
        request.setExecutionTimeout(7000L);
        request.setMaxOutput(3000);
        request.setStatus(Mcp.STATUS_DISABLED);

        when(repository.findById(5L)).thenReturn(Optional.of(sampleModel()));
        when(repository.findByName("gh")).thenReturn(Optional.empty());

        controller.update(request);

        ArgumentCaptor<Mcp> captor = ArgumentCaptor.forClass(Mcp.class);
        verify(repository).updateById(captor.capture());
        Mcp updated = captor.getValue();
        assertEquals("gh", updated.getName());
        assertEquals(Mcp.TRANSPORT_SSE, updated.getTransport());
        assertEquals("https://gh/mcp/", updated.getUrl());
        assertEquals("Bearer t", updated.getHeaders().get("Authorization"));
        assertEquals("g_", updated.getToolNamePrefix());
        assertEquals(Duration.ofMillis(5000), updated.getInitializationTimeout());
        assertEquals(Duration.ofMillis(7000), updated.getExecutionTimeout());
        assertEquals(3000, updated.getMaxOutput());
        assertEquals(Mcp.STATUS_DISABLED, updated.getStatus());
    }
}
