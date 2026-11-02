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
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

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
        when(imageModel.generate(anyString())).thenReturn(ChatResponseEntity.builder()
                .aiMessageEntity(AiMessageEntity.builder().images(List.of(Image.from(Base64.getEncoder().encodeToString(png())))).build())
                .tokenUsage(TokenUsageEntity.of(95, 15, 80)).build());
        return new GenerateImageToolExecutor(mapper, models, providers, new GeneratedImageFileWriter(), new ImageCacheDirectory(root.resolve("cache").toString()));
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
        verify(imageModel).generate("A red sailboat with a white sail");
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
        verify(imageModel).generate(anyString());
    }

    private byte[] png() throws Exception {
        BufferedImage image=new BufferedImage(3,2,BufferedImage.TYPE_INT_ARGB);
        image.setRGB(1,1,0xffe87832);
        ByteArrayOutputStream output=new ByteArrayOutputStream();
        ImageIO.write(image,"png",output);
        return output.toByteArray();
    }
}
