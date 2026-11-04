package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Image;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.model.DefaultModelProviderNames;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.image.ImageGenerationOptions;
import com.summit.core.model.image.ImageModel;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.model.application.service.ModelService;
import com.summit.runtime.workspace.LocalWorkspace;
import com.sun.net.httpserver.HttpServer;
import openAi.image.DefaultImageModel;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** 蒙版须进入真实请求，输出要求不满足时仍保留已产生用量。 */
class GenerateImageMaskTest {
    @TempDir Path root;
    private final ObjectMapper mapper = new ObjectMapper();
    private final ModelService models = mock(ModelService.class);
    @SuppressWarnings("unchecked")
    private final ModelProviderRegistry<ImageModel> providers = mock(ModelProviderRegistry.class);

    @Test
    void uploadsMaskBytesAndOutputRequirementsThroughTheExistingSdk() throws Exception {
        byte[] reference = image("transparent", 3);
        byte[] mask = image("mask", 3);
        Files.write(root.resolve("ref.png"), reference);
        Files.write(root.resolve("mask.png"), mask);
        AtomicReference<byte[]> request = new AtomicReference<>();
        AtomicReference<String> route = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            route.set(exchange.getRequestURI().getPath());
            request.set(exchange.getRequestBody().readAllBytes());
            byte[] body = mapper.writeValueAsBytes(Map.of("created", 1,
                    "data", List.of(Map.of("b64_json", Base64.getEncoder().encodeToString(reference))),
                    "usage", Map.of("input_tokens", 15, "output_tokens", 80, "total_tokens", 95)));
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream stream = exchange.getResponseBody()) { stream.write(body); }
        });
        server.start();
        try {
            when(models.runtimeConfig(eq(9L), isNull())).thenReturn(ModelConfig.builder()
                    .provider(DefaultModelProviderNames.DEFAULT_IMAGE).modelName("image-test").apiKey("test-key")
                    .baseUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/v1").build());
            when(providers.create(any())).thenAnswer(invocation -> imageModelOf(invocation.getArgument(0)));
            ToolExecuteResult result = executor().execute(call(arguments()));
            assertTrue(result.isSuccess(), result.getToolOutput());
            assertEquals("/v1/images/edits", route.get());
            String multipart = new String(request.get(), StandardCharsets.ISO_8859_1);
            String payload = new String(mask, StandardCharsets.ISO_8859_1);
            int maskOffset = multipart.indexOf("name=\"mask\"");
            assertTrue(maskOffset >= 0, multipart);
            assertTrue(multipart.substring(maskOffset).contains(payload), "蒙版原始字节必须随 mask 文件上传");
            assertTrue(multipart.substring(0, maskOffset).contains(new String(reference, StandardCharsets.ISO_8859_1)));
            assertTrue(multipart.contains("name=\"background\"\r\n\r\ntransparent"));
            assertTrue(multipart.contains("name=\"output_format\"\r\n\r\npng"));
            assertArrayEquals(reference, Files.readAllBytes(root.resolve("out.png")));
            assertArrayEquals(mask, Files.readAllBytes(root.resolve("mask.png")));
        } finally {
            server.stop(0);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"no-reference", "wrong-size", "rgb", "opaque", "semi", "jpeg", "missing", "outside", "null", "number"})
    void rejectsInvalidMasksBeforeCreatingTheProvider(String problem) throws Exception {
        Files.write(root.resolve("ref.png"), image("transparent", 3));
        Files.write(root.resolve("mask.png"), image("transparent", 3));
        Map<String, Object> args = arguments();
        switch (problem) {
            case "no-reference" -> args.remove("reference_image_path");
            case "wrong-size" -> Files.write(root.resolve("mask.png"), image("transparent", 4));
            case "rgb", "opaque", "semi", "jpeg" -> Files.write(root.resolve("mask.png"), image(problem, 3));
            case "missing" -> args.put("mask_image_path", "missing.png");
            case "outside" -> args.put("mask_image_path", "../outside.png");
            case "null" -> args.put("mask_image_path", null);
            case "number" -> args.put("mask_image_path", 123);
            default -> fail(problem);
        }
        when(models.runtimeConfig(eq(9L), isNull())).thenReturn(ModelConfig.builder()
                .provider(DefaultModelProviderNames.DEFAULT_IMAGE).modelName("image-test").build());
        ToolExecuteResult result = executor().execute(call(args));
        assertFalse(result.isSuccess(), problem);
        verifyNoInteractions(providers);
        assertFalse(Files.exists(root.resolve("out.png")));
    }

    @ParameterizedTest
    @CsvSource({"rgb,transparent,png,alpha", "opaque,transparent,png,透明像素", "semi,transparent,png,透明像素",
            "jpeg,auto,png,格式", "transparent,opaque,png,不透明背景"})
    void rejectsNonconformingRawOutputsBeforeSavingAndKeepsUsage(String mode, String background, String format, String error) throws Exception {
        Files.write(root.resolve("ref.png"), image("transparent", 3));
        Files.write(root.resolve("mask.png"), image("transparent", 3));
        ImageModel model = mock(ImageModel.class);
        when(models.runtimeConfig(eq(9L), isNull())).thenReturn(ModelConfig.builder()
                .provider(DefaultModelProviderNames.DEFAULT_IMAGE).modelName("image-test").build());
        when(providers.create(any())).thenReturn(model);
        when(model.edit(any(Image.class), any(Image.class), anyString(), any())).thenReturn(ChatResponseEntity.builder()
                .aiMessageEntity(AiMessageEntity.builder().images(List.of(Image.from(Base64.getEncoder().encodeToString(image(mode, 3))))).build())
                .tokenUsage(TokenUsageEntity.of(95, 15, 80)).build());
        Map<String, Object> args = arguments();
        args.put("background", background);
        args.put("output_format", format);
        ToolExecuteResult result = executor().execute(call(args));
        assertFalse(result.isSuccess(), mode);
        assertTrue(result.getToolOutput().contains(error), result.getToolOutput());
        assertFalse(Files.exists(root.resolve("out.png")));
        assertEquals(95, mapper.valueToTree(result.getToolMetaData().get(GenerateImageInterceptor.USAGE)).path("totalTokens").asInt());
        verify(model).edit(any(Image.class), any(Image.class), eq("保留轮廓，润色蒙版区域"),
                eq(new ImageGenerationOptions("1024x1024", null, 1, background, format)));
    }

    /** 框架自带的生图实现：对本地 HTTP 端点发真实请求，蒙版必须真的进入 multipart 请求体。 */
    private ImageModel imageModelOf(ModelConfig selected) {
        return new DefaultImageModel(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build(), mapper, selected);
    }

    private GenerateImageToolExecutor executor() {
        return new GenerateImageToolExecutor(mapper, models, providers, new GeneratedImageFileWriter(),
                new ImageCacheDirectory(root.resolve("cache").toString()), new ImageGenerationSpecValidator(), new ReferenceImageLoader());
    }

    private Map<String, Object> arguments() {
        Map<String, Object> args = new HashMap<>();
        args.put("prompt", "保留轮廓，润色蒙版区域");
        args.put("path", "out.png");
        args.put("reference_image_path", "ref.png");
        args.put("mask_image_path", "mask.png");
        args.put("background", "transparent");
        return args;
    }

    private ToolExecution call(Map<String, Object> args) throws Exception {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, 42L);
        attributes.put(GenerateImageInterceptor.MODEL, 9L);
        attributes.put(GenerateImageInterceptor.LIMIT, 1);
        attributes.put(GenerateImageInterceptor.ALLOWED, List.of("mask-1"));
        return ToolExecution.builder().id("mask-1").executionId("100").workspace(new LocalWorkspace("w", root.toString()))
                .attributes(attributes).args(mapper.writeValueAsString(args)).build();
    }

    private byte[] image(String mode, int width) throws Exception {
        boolean rgb = mode.equals("rgb") || mode.equals("jpeg");
        BufferedImage image = new BufferedImage(width, 2, rgb ? BufferedImage.TYPE_INT_RGB : BufferedImage.TYPE_INT_ARGB);
        if (mode.equals("opaque") || mode.equals("semi")) {
            for (int y = 0; y < 2; y++) for (int x = 0; x < width; x++) image.setRGB(x, y, mode.equals("semi") ? 0x80eeeeee : 0xffeeeeee);
        }
        image.setRGB(1, 1, mode.equals("mask") ? 0xffffffff : 0xffe87832);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        assertTrue(ImageIO.write(image, mode.equals("jpeg") ? "jpg" : "png", output));
        return output.toByteArray();
    }
}
