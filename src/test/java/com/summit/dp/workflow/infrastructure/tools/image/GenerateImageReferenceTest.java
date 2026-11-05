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
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.model.application.service.ModelService;
import com.summit.runtime.workspace.LocalWorkspace;
import com.sun.net.httpserver.HttpServer;
import openAi.image.DefaultImageModel;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.CRC32;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** 原图须真正进入编辑请求，不能退回仅凭文字重新生成。 */
class GenerateImageReferenceTest {
    @TempDir Path root;
    private final ObjectMapper mapper = new ObjectMapper();
    private final ModelService models = mock(ModelService.class);
    @SuppressWarnings("unchecked")
    private final ModelProviderRegistry<ImageModel> providers = mock(ModelProviderRegistry.class);

    @ParameterizedTest
    @CsvSource({"png,false", "png,true", "jpg,false", "jpg,true"})
    void uploadsExactReferenceBytesAndPerCallOptionsToEdits(String format, boolean absolute) throws Exception {
        byte[] original = image(format, 1800);
        byte[] output = image("png", 3);
        Path input = root.resolve("original.dat");
        Files.write(input, original);
        AtomicReference<byte[]> received = new AtomicReference<>();
        AtomicReference<String> route = new AtomicReference<>();
        AtomicReference<String> contentType = new AtomicReference<>();
        AtomicReference<String> header = new AtomicReference<>();
        AtomicInteger calls = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            calls.incrementAndGet();
            route.set(exchange.getRequestURI().getPath());
            contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
            header.set(exchange.getRequestHeaders().getFirst("X-Route"));
            received.set(exchange.getRequestBody().readAllBytes());
            byte[] body = mapper.writeValueAsBytes(Map.of("created", 1,
                    "data", List.of(Map.of("b64_json", Base64.getEncoder().encodeToString(output))),
                    "usage", Map.of("input_tokens", 15, "output_tokens", 80, "total_tokens", 95)));
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream stream = exchange.getResponseBody()) { stream.write(body); }
        });
        server.start();
        try {
            ModelConfig config = ModelConfig.builder().provider(DefaultModelProviderNames.DEFAULT_IMAGE).modelName("image-test")
                    .apiKey("local-test-key").baseUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/v1")
                    .maxRetries(5).imageOptions(new ModelConfig.ImageOptions("low", "1024x1024", Map.of("X-Route", "edits"), 2)).build();
            when(models.runtimeConfig(eq(9L), isNull())).thenReturn(config);
            when(providers.create(any())).thenAnswer(invocation -> imageModelOf(invocation.getArgument(0)));
            ToolExecuteResult result = executor().execute(call(absolute ? input.toString() : "original.dat"));
            assertTrue(result.isSuccess(), result.getToolOutput());
            assertEquals(1, calls.get());
            assertEquals("/v1/images/edits", route.get());
            assertTrue(contentType.get().startsWith("multipart/form-data;"));
            assertEquals("edits", header.get());
            String multipart = new String(received.get(), StandardCharsets.ISO_8859_1);
            assertTrue(multipart.contains(new String(original, StandardCharsets.ISO_8859_1)), "上传必须保留原图字节，不能缩到看图尺寸");
            assertTrue(multipart.contains("image/" + (format.equals("jpg") ? "jpeg" : "png")));
            assertTrue(multipart.contains("1536x1024"));
            assertTrue(multipart.contains("high"));
            assertTrue(new String(received.get(), StandardCharsets.UTF_8).contains("保留构图，润色光影"));
            assertArrayEquals(original, Files.readAllBytes(input));
            assertArrayEquals(output, Files.readAllBytes(root.resolve("polished.png")));
            JsonNode receipt = mapper.readTree(result.getToolOutput());
            assertEquals("1536x1024", receipt.path("size").asText());
            assertTrue(receipt.path("previewUrl").asText().startsWith("/a/images/42/"));
            assertEquals(95, mapper.valueToTree(result.getToolMetaData().get(GenerateImageInterceptor.USAGE)).path("totalTokens").asInt());
            assertFalse(result.getToolOutput().contains(Base64.getEncoder().encodeToString(original)));
            assertEquals("low", config.getImageOptions().quality());
            verify(providers).create(argThat(selected -> selected.getMaxRetries() == 0
                    && "1024x1024".equals(selected.getImageOptions().size())));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void rejectsInvalidReferencesBeforeCreatingTheModel(@TempDir Path outside) throws Exception {
        Files.write(root.resolve("valid.png"), image("png", 3));
        Files.writeString(root.resolve("fake.png"), "not an image");
        Files.write(root.resolve("broken.png"), Arrays.copyOf(image("png", 3), 24));
        Files.createDirectory(root.resolve("directory.png"));
        Files.write(outside.resolve("outside.png"), image("png", 3));
        when(models.runtimeConfig(eq(9L), isNull())).thenReturn(ModelConfig.builder()
                .provider(DefaultModelProviderNames.DEFAULT_IMAGE).modelName("image-test").build());
        for (Object reference : List.of("", " ", 7, List.of("valid.png"), "missing.png", "directory.png", "fake.png", "broken.png",
                "../outside.png", outside.resolve("outside.png").toString(), "https://example.com/ref.png", "data:image/png;base64,abc")) {
            ToolExecuteResult result = executor().execute(call(reference));
            assertFalse(result.isSuccess(), String.valueOf(reference));
            assertFalse(Files.exists(root.resolve("polished.png")));
        }
        ToolExecuteResult nullResult = executor().execute(call(null));
        assertFalse(nullResult.isSuccess(), nullResult.getToolOutput());
        verifyNoInteractions(providers);
    }

    @Test
    void rejectsInvalidReferenceArraysBeforeCreatingTheModel() throws Exception {
        Files.write(root.resolve("valid.png"), image("png", 3));
        when(models.runtimeConfig(eq(9L), isNull())).thenReturn(ModelConfig.builder()
                .provider(DefaultModelProviderNames.DEFAULT_IMAGE).modelName("image-test").build());
        for (Map<String, Object> args : List.<Map<String, Object>>of(
                Collections.singletonMap("reference_image_paths", null),
                Map.of("reference_image_paths", "valid.png"),
                Map.of("reference_image_paths", List.of()),
                Map.of("reference_image_paths", Collections.nCopies(17, "valid.png")),
                Map.of("reference_image_paths", List.of("valid.png", 123)),
                Map.of("reference_image_paths", List.of("valid.png", "../outside.png")),
                Map.of("reference_image_path", "valid.png", "reference_image_paths", List.of("valid.png")))) {
            ToolExecuteResult result = executor().execute(callWithReferences(args));
            assertFalse(result.isSuccess(), args.toString());
        }
        verifyNoInteractions(providers);
        assertFalse(Files.exists(root.resolve("polished.png")));
    }

    @Test
    void rejectsOversizedFilesAndPixelHeadersBeforeCreatingTheModel() throws Exception {
        byte[] oversized = new byte[ReferenceImageLoader.MAX_BYTES + 1];
        Files.write(root.resolve("large.png"), oversized);
        byte[] pixelBomb = image("png", 3);
        ByteBuffer.wrap(pixelBomb).putInt(16, 100_000).putInt(20, 100_000);
        CRC32 checksum = new CRC32();
        checksum.update(pixelBomb, 12, 17);
        ByteBuffer.wrap(pixelBomb).putInt(29, (int) checksum.getValue());
        Files.write(root.resolve("pixels.png"), pixelBomb);
        when(models.runtimeConfig(eq(9L), isNull())).thenReturn(ModelConfig.builder()
                .provider(DefaultModelProviderNames.DEFAULT_IMAGE).modelName("image-test").build());
        ToolExecuteResult large = executor().execute(call("large.png"));
        assertFalse(large.isSuccess());
        assertTrue(large.getToolOutput().contains("16MB"), large.getToolOutput());
        ToolExecuteResult pixels = executor().execute(call("pixels.png"));
        assertFalse(pixels.isSuccess());
        assertTrue(pixels.getToolOutput().contains("4000 万像素"), pixels.getToolOutput());
        verifyNoInteractions(providers);
    }

    @Test
    void rejectsReferencesWhoseLinksPointOutside(@TempDir Path outside) throws Exception {
        Files.write(outside.resolve("ref.png"), image("png", 3));
        try { Files.createSymbolicLink(root.resolve("linked"), outside); }
        catch (Exception unavailable) { Assumptions.assumeTrue(false, "当前环境不允许创建符号链接"); }
        when(models.runtimeConfig(eq(9L), isNull())).thenReturn(ModelConfig.builder()
                .provider(DefaultModelProviderNames.DEFAULT_IMAGE).modelName("image-test").build());
        ToolExecuteResult result = executor().execute(call("linked/ref.png"));
        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("工作区之外"), result.getToolOutput());
        verifyNoInteractions(providers);
    }

    @Test
    void returnsEditServiceErrorsWithoutRetryOrTextGenerationFallback() throws Exception {
        Files.write(root.resolve("ref.png"), image("png", 3));
        AtomicInteger calls = new AtomicInteger();
        AtomicReference<String> route = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            calls.incrementAndGet();
            route.set(exchange.getRequestURI().getPath());
            exchange.getRequestBody().readAllBytes();
            byte[] body = "{\"error\":{\"message\":\"image editing is not supported by this model\"}}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(400, body.length);
            try (OutputStream stream = exchange.getResponseBody()) { stream.write(body); }
        });
        server.start();
        try {
            when(models.runtimeConfig(eq(9L), isNull())).thenReturn(ModelConfig.builder()
                    .provider(DefaultModelProviderNames.DEFAULT_IMAGE).modelName("image-test").apiKey("local-test-key").maxRetries(5)
                    .baseUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/v1").build());
            when(providers.create(any())).thenAnswer(invocation -> imageModelOf(invocation.getArgument(0)));
            ToolExecuteResult result = executor().execute(call("ref.png"));
            assertFalse(result.isSuccess());
            // 真实服务错误原样上抛：HTTP 状态与服务端 error.message 都必须进入文案，且不重试、不退回文字生成。
            assertTrue(result.getToolOutput()
                            .contains("Image edits failed with HTTP 400: image editing is not supported by this model"),
                    result.getToolOutput());
            assertEquals(1, calls.get());
            assertEquals("/v1/images/edits", route.get());
            assertFalse(Files.exists(root.resolve("polished.png")));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void failedSavingStillReturnsBilledEditingUsage() throws Exception {
        Files.write(root.resolve("ref.png"), image("png", 3));
        ImageModel model = mock(ImageModel.class);
        when(models.runtimeConfig(eq(9L), isNull())).thenReturn(ModelConfig.builder()
                .provider(DefaultModelProviderNames.DEFAULT_IMAGE).modelName("image-test").build());
        when(providers.create(any())).thenReturn(model);
        when(model.edit(any(Image.class), anyString(), any())).thenReturn(ChatResponseEntity.builder()
                .aiMessageEntity(AiMessageEntity.builder().images(List.of(Image.from(Base64.getEncoder().encodeToString(image("png", 3))))).build())
                .tokenUsage(TokenUsageEntity.of(95, 15, 80)).build());
        GeneratedImageFileWriter writer = spy(new GeneratedImageFileWriter());
        doThrow(new IOException("模拟保存失败")).when(writer).write(any(), any(), any());
        GenerateImageToolExecutor executor = new GenerateImageToolExecutor(mapper, models, providers, writer,
                new ImageCacheDirectory(root.resolve("cache").toString()), new ImageGenerationSpecValidator(), new ReferenceImageLoader());
        ToolExecuteResult result = executor.execute(call("ref.png"));
        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("模拟保存失败"));
        assertEquals(95, mapper.valueToTree(result.getToolMetaData().get(GenerateImageInterceptor.USAGE)).path("totalTokens").asInt());
        verify(model, never()).generate(anyString(), any(ImageGenerationOptions.class));
    }

    @Test
    void remoteWorkspacesReadBytesThroughTheirBridge() throws Exception {
        Workspace workspace = mock(Workspace.class);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        WorkspaceFiles files = mock(WorkspaceFiles.class);
        Path path = Path.of("/remote/ref.png");
        byte[] original = image("png", 3);
        when(workspace.resolve("ref.png")).thenReturn(path);
        when(workspace.encloses(path)).thenReturn(true);
        when(workspace.bridge()).thenReturn(bridge);
        when(bridge.files()).thenReturn(files);
        when(files.readBytes(path)).thenReturn(original);
        Image reference = new ReferenceImageLoader()
                .loadReferences(mapper.valueToTree(Map.of("reference_image_path", "ref.png")), workspace).getFirst();
        assertEquals("image/png", reference.mimeType());
        assertArrayEquals(original, Base64.getDecoder().decode(reference.getBase64Data()));
        verify(files).readBytes(path);
    }

    /** 框架自带的生图实现：对本地 HTTP 端点发真实请求，保证请求体与响应解析都走生产同一份代码。 */
    private ImageModel imageModelOf(ModelConfig selected) {
        return new DefaultImageModel(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build(), mapper, selected);
    }

    private GenerateImageToolExecutor executor() {
        return new GenerateImageToolExecutor(mapper, models, providers, new GeneratedImageFileWriter(),
                new ImageCacheDirectory(root.resolve("cache").toString()), new ImageGenerationSpecValidator(), new ReferenceImageLoader());
    }

    private ToolExecution call(Object reference) throws Exception {
        return callWithReferences(Collections.singletonMap("reference_image_path", reference));
    }

    private ToolExecution callWithReferences(Map<String, Object> references) throws Exception {
        Map<String, Object> args = new HashMap<>();
        args.put("prompt", "保留构图，润色光影");
        args.put("path", "polished.png");
        args.putAll(references);
        args.put("size", "1536x1024");
        args.put("quality", "high");
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, 42L);
        attributes.put(GenerateImageInterceptor.MODEL, 9L);
        attributes.put(GenerateImageInterceptor.LIMIT, 1);
        attributes.put(GenerateImageInterceptor.ALLOWED, List.of("image-1"));
        return ToolExecution.builder().id("image-1").executionId("100")
                .workspace(new LocalWorkspace("workspace", root.toString())).attributes(attributes)
                .args(mapper.writeValueAsString(args)).build();
    }

    private byte[] image(String format, int width) throws Exception {
        BufferedImage image = new BufferedImage(width, 2, format.equals("jpg") ? BufferedImage.TYPE_INT_RGB : BufferedImage.TYPE_INT_ARGB);
        image.setRGB(1, 1, 0xffe87832);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        assertTrue(ImageIO.write(image, format, output));
        return output.toByteArray();
    }
}
