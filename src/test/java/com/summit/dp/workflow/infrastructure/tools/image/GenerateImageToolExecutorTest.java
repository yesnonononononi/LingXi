package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Image;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.model.DefaultModelProviderNames;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.image.ImageModel;
import com.summit.core.model.image.ImageGenerationOptions;
import com.summit.adapter.langchain4j.model.provider.CommonImageModelProvider;
import com.sun.net.httpserver.HttpServer;
import com.summit.core.tool.ToolDefinition;
import com.summit.dp.workflow.infrastructure.tools.config.AnnotatedToolTestDefinitions;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.model.application.service.ModelService;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** 外部调用、工作区写入和执行配额必须同时受约束。 */
class GenerateImageToolExecutorTest {
    @TempDir Path root;
    private final ObjectMapper mapper = new ObjectMapper();
    private final ModelService models = mock(ModelService.class);
    @SuppressWarnings("unchecked")
    private final ModelProviderRegistry<ImageModel> providers = mock(ModelProviderRegistry.class);
    private final ImageModel imageModel = mock(ImageModel.class);

    private GenerateImageToolExecutor executor() throws Exception {
        when(models.runtimeConfig(eq(9L), isNull())).thenReturn(ModelConfig.builder()
                .provider(DefaultModelProviderNames.DEFAULT_IMAGE).modelName("image-test").maxRetries(5).build());
        when(providers.create(any())).thenReturn(imageModel);
        when(imageModel.generate(anyString(), any(ImageGenerationOptions.class))).thenReturn(ChatResponseEntity.builder()
                .aiMessageEntity(AiMessageEntity.builder().images(List.of(Image.from(Base64.getEncoder().encodeToString(png())))).build())
                .tokenUsage(TokenUsageEntity.of(95, 15, 80)).build());
        return new GenerateImageToolExecutor(mapper, models, providers, new GeneratedImageFileWriter(),
                new ImageCacheDirectory(root.resolve("cache").toString()), new ImageGenerationSpecValidator(), new ReferenceImageLoader());
    }

    private ToolExecution call(String path) throws Exception {
        Map<String,Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, 42L);
        attributes.put(GenerateImageInterceptor.MODEL, 9L);
        attributes.put(GenerateImageInterceptor.LIMIT, 1);
        attributes.put(GenerateImageInterceptor.ALLOWED, List.of("call-1"));
        return ToolExecution.builder().id("call-1").executionId("100")
                .workspace(new LocalWorkspace("w", root.toString())).attributes(attributes)
                .args(mapper.writeValueAsString(Map.of("prompt","A red sailboat with a white sail", "path",path))).build();
    }

    @Test void writesExactBytesAndReturnsPersistentPreviewAndUsage() throws Exception {
        ToolExecuteResult result = executor().execute(call("art/boat.png"));
        assertTrue(result.isSuccess(),result.getToolOutput());
        assertArrayEquals(png(),Files.readAllBytes(root.resolve("art/boat.png")));
        JsonNode receipt = mapper.readTree(result.getToolOutput());
        assertEquals("art/boat.png",receipt.path("path").asText());
        assertTrue(receipt.path("previewUrl").asText().startsWith("/a/images/42/"));
        assertEquals(95,mapper.valueToTree(result.getToolMetaData().get(GenerateImageInterceptor.USAGE)).path("totalTokens").asInt());
        verify(imageModel).generate("A red sailboat with a white sail", new ImageGenerationOptions("1024x1024", null, 1));
        assertEquals("1024x1024", receipt.path("size").asText());
        verify(providers).create(argThat(config -> config.getMaxRetries()==0));
    }

    @Test void refusesOutsidePathsAndExistingFilesBeforeCharging() throws Exception {
        GenerateImageToolExecutor executor = executor();
        Files.writeString(root.resolve("existing.png"),"keep");
        for(String path:List.of("../escape.png","existing.png","bad.txt",root.resolve("absolute.png").toString())) {
            assertFalse(executor.execute(call(path)).isSuccess(),path);
        }
        assertEquals("keep",Files.readString(root.resolve("existing.png")));
        verifyNoInteractions(imageModel);
    }

    @Test void refusesCallsWithoutQuotaAndDoesNotInvokeTheModel() throws Exception {
        GenerateImageToolExecutor executor=executor();
        ToolExecution call=call("out.png");
        call.getAttributes().put(GenerateImageInterceptor.ALLOWED,List.of());
        assertFalse(executor.execute(call).isSuccess());
        assertFalse(Files.exists(root.resolve("out.png")));
        verifyNoInteractions(imageModel);
    }

    @Test void outputExtensionMatchesActualJpegBytes() throws Exception {
        ToolExecuteResult result=executor().execute(call("art/boat.jpg"));
        assertTrue(result.isSuccess(),result.getToolOutput());
        assertEquals(ImageFormat.JPEG,ImageFormat.detect(Files.readAllBytes(root.resolve("art/boat.jpg"))));
    }

    @Test void rejectsWorkspaceLinksPointingOutsideBeforeCharging(@TempDir Path outside) throws Exception {
        try { Files.createSymbolicLink(root.resolve("outside-link"), outside); }
        catch (Exception unavailable) { Assumptions.assumeTrue(false,"当前环境不允许创建符号链接"); }
        GenerateImageToolExecutor executor=executor();
        assertFalse(executor.execute(call("outside-link/escape.png")).isSuccess());
        assertFalse(Files.exists(outside.resolve("escape.png")));
        verifyNoInteractions(imageModel);
    }

    @Test void writingFailureRetainsBilledUsage() throws Exception {
        GenerateImageToolExecutor executor=executor();
        Files.writeString(root.resolve("not-a-directory"),"keep");
        ToolExecuteResult result=executor.execute(call("not-a-directory/boat.png"));
        assertFalse(result.isSuccess());
        assertNotNull(result.getToolMetaData().get(GenerateImageInterceptor.USAGE));
        verify(imageModel).generate(anyString(), any(ImageGenerationOptions.class));
    }

    @Test void forwardsPerCallSpecificationsAndRejectsInvalidSizesBeforeCallingProvider() throws Exception {
        GenerateImageToolExecutor executor = executor();
        ToolExecution call = call("art/wide.png");
        call.setArgs(mapper.writeValueAsString(Map.of("prompt", "wide scene", "path", "art/wide.png",
                "size", "123x456", "quality", "custom-quality")));
        assertTrue(executor.execute(call).isSuccess());
        verify(imageModel).generate("wide scene", new ImageGenerationOptions("123x456", "custom-quality", 1));
        clearInvocations(imageModel, providers);
        call.setArgs(mapper.writeValueAsString(Map.of("prompt", "bad size", "path", "art/bad.png", "size", "123*456")));
        ToolExecuteResult result = executor.execute(call);
        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("正整数宽x高"), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("可不传"), result.getToolOutput());
        assertFalse(Files.exists(root.resolve("art/bad.png")));
        verifyNoInteractions(providers, imageModel);
    }

    @Test void returnsTheRealServiceErrorWhenFormattedSpecificationsAreUnsupported() throws Exception {
        GenerateImageToolExecutor executor = executor();
        AtomicReference<JsonNode> received = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/images/generations", exchange -> {
            received.set(mapper.readTree(exchange.getRequestBody()));
            byte[] error = "{\"error\":{\"message\":\"unsupported size 123x456\",\"type\":\"invalid_request_error\",\"code\":\"invalid_size\"}}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(400, error.length);
            try (OutputStream output = exchange.getResponseBody()) { output.write(error); }
        });
        server.start();
        try {
            when(models.runtimeConfig(eq(9L), isNull())).thenReturn(ModelConfig.builder()
                    .provider(DefaultModelProviderNames.DEFAULT_IMAGE).modelName("gpt-image-1")
                    .baseUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/v1").apiKey("test-key").build());
            when(providers.create(any())).thenAnswer(invocation -> new CommonImageModelProvider().create(invocation.getArgument(0)));
            ToolExecution call = call("unsupported.png");
            call.setArgs(mapper.writeValueAsString(Map.of("prompt", "draw", "path", "unsupported.png", "size", "123x456")));
            ToolExecuteResult result = executor.execute(call);
            assertFalse(result.isSuccess());
            assertNotNull(received.get());
            assertEquals("123x456", received.get().path("size").asText());
            assertTrue(result.getToolOutput().contains("unsupported size 123x456"), result.getToolOutput());
            assertFalse(Files.exists(root.resolve("unsupported.png")));
        } finally {
            server.stop(0);
        }
    }

    @Test void advertisesOptionalSpecificationsAndTheirDefaultsInTheActualToolSchema() throws Exception {
        ToolDefinition<GenerateImageToolExecutor> definition = AnnotatedToolTestDefinitions.create(GenerateImageToolExecutor.class, executor());
        JsonNode schema = mapper.readTree(definition.parametersJsonSchema());
        assertEquals(mapper.valueToTree(List.of("prompt", "path")), schema.path("required"));
        assertFalse(schema.path("additionalProperties").asBoolean());
        JsonNode properties = schema.path("properties");
        assertEquals("string", properties.path("reference_image_path").path("type").asText());
        assertTrue(properties.path("reference_image_path").path("description").asText().contains("绝对路径"));
        assertEquals("string", properties.path("size").path("type").asText());
        assertTrue(properties.path("size").path("description").asText().contains("可不传"));
        assertTrue(properties.path("size").path("description").asText().contains("1024x1024"));
        assertTrue(properties.path("quality").path("description").asText().contains("可不传"));
        assertEquals(1, properties.path("count").path("default").asInt());
        assertEquals(mapper.valueToTree(List.of(1)), properties.path("count").path("enum"));
        assertTrue(definition.description().contains("1024x1024"));
        assertTrue(definition.description().contains("均可不传"));
    }

    private byte[] png() throws Exception {
        BufferedImage image=new BufferedImage(3,2,BufferedImage.TYPE_INT_ARGB);
        image.setRGB(1,1,0xffe87832);
        ByteArrayOutputStream output=new ByteArrayOutputStream();
        ImageIO.write(image,"png",output);
        return output.toByteArray();
    }
}
