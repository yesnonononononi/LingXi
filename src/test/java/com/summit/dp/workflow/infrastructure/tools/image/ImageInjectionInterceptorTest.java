package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.conversation.message.content.ImageContent;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopMessages;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.json.ExecutionJson;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.arguments.ReadImageRequest;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** 注入时机、去重与失败降级。 */
class ImageInjectionInterceptorTest {

    private static final long SESSION_ID = 7L;

    private final ObjectMapper mapper = new ObjectMapper();
    @TempDir Path dataDir;
    @TempDir Path workspaceRoot;

    @Test
    void capsImagesFromOneConcurrentToolBatchAndPersistsTheBudget() throws Exception {
        Execution execution = execution();
        List<ToolExecuteResult> results = new ArrayList<>();
        for (int index = 0; index < 11; index++) {
            String name = "image-" + index + ".png";
            prepareImage(name);
            // 改一个像素，确保每张图的内容哈希不同，否则只是在验证去重。
            BufferedImage image = ImageIO.read(workspaceRoot.resolve(name).toFile());
            image.setRGB(0, 0, index);
            ImageIO.write(image, "png", workspaceRoot.resolve(name).toFile());
            results.add(read(name, execution));
        }
        ImageInjectionInterceptor interceptor = interceptor();
        interceptor.onAfterToolCall(context(execution), results);
        ObjectMapper snapshots = ExecutionJson.newObjectMapper();
        Execution restored = snapshots.readValue(snapshots.writeValueAsBytes(execution), Execution.class);
        List<Message> appended = new ArrayList<>();
        interceptor.onBeforeModelInvoke(context(restored, appended));
        UserMessageEntity message = assertInstanceOf(UserMessageEntity.class, appended.getFirst());
        assertEquals(10, message.getContent().stream().filter(ImageContent.class::isInstance).count());
        assertTrue(message.text().contains("上限"));
        assertEquals(10, restored.getAgentRequest().runtimeParametersOrDefault().getAttributes().get(ReadImageToolExecutor.KEY_CONSUMED));
        assertEquals(11, results.stream().map(result -> result.getToolMetaData().get("imageId")).distinct().count());
        assertEquals("BUDGET_EXHAUSTED", mapper.readTree(read("image-0.png", restored).getToolOutput()).path("reason").asText());
        interceptor.onBeforeModelInvoke(context(restored, appended));
        assertEquals(1, appended.size());
    }

    @Test
    void ignoresImageMetadataFromUnrelatedTools() throws Exception {
        prepareImage("logo.png");
        Execution execution = execution();
        ToolExecuteResult result = read("logo.png", execution);
        result.setToolSpecification(definition(ToolCatalog.READ_FILE));
        ImageInjectionInterceptor interceptor = interceptor();
        interceptor.onAfterToolCall(context(execution), List.of(result));
        List<Message> appended = new ArrayList<>();
        interceptor.onBeforeModelInvoke(context(execution, appended));
        assertTrue(appended.isEmpty());
    }

    @Test
    void failedAppendKeepsPendingImagesForRetry() throws Exception {
        prepareImage("logo.png");
        Execution execution = execution();
        ImageInjectionInterceptor interceptor = interceptor();
        interceptor.onAfterToolCall(context(execution), List.of(read("logo.png", execution)));
        LoopContext failing = LoopContext.withCompactionCounter(LoopMessages.builder().execution(execution).build(),
                null, () -> 0, messages -> { throw new IllegalStateException("模拟追加失败"); });
        assertThrows(IllegalStateException.class, () -> interceptor.onBeforeModelInvoke(failing));
        List<Message> appended = new ArrayList<>();
        interceptor.onBeforeModelInvoke(context(execution, appended));
        assertEquals(1, appended.size());
        assertInstanceOf(ImageContent.class, assertInstanceOf(UserMessageEntity.class, appended.getFirst()).getContent().get(1));
    }

    @Test
    void injectsImageAsUserMessageAndConsumesPendingOnce() throws Exception {
        prepareImage("logo.png");
        Execution execution = execution();
        ImageInjectionInterceptor interceptor = interceptor();
        List<Message> appended = new ArrayList<>();

        ToolExecuteResult result = read("logo.png", execution);
        assertTrue(result.isSuccess(), () -> result.getToolOutput());
        interceptor.onAfterToolCall(context(execution), List.of(result));
        interceptor.onBeforeModelInvoke(context(execution, appended));

        assertEquals(1, appended.size());
        UserMessageEntity message = assertInstanceOf(UserMessageEntity.class, appended.getFirst());
        assertEquals(2, message.getContent().size());
        assertInstanceOf(ImageContent.class, message.getContent().get(1));
        assertTrue(message.text().contains("logo.png"));

        // 第二轮：队列已清空，不应再注入。
        interceptor.onBeforeModelInvoke(context(execution, appended));
        assertEquals(1, appended.size());
    }

    @Test
    void doesNotReinjectSameImageTwice() throws Exception {
        prepareImage("logo.png");
        Execution execution = execution();
        ImageInjectionInterceptor interceptor = interceptor();
        List<Message> appended = new ArrayList<>();

        injectOnce(interceptor, execution, appended, "logo.png");
        injectOnce(interceptor, execution, appended, "logo.png");

        assertEquals(2, appended.size());
        UserMessageEntity second = assertInstanceOf(UserMessageEntity.class, appended.get(1));
        assertEquals(1, second.getContent().size());
        assertTrue(second.text().contains("不重复提供"));
    }

    @Test
    void degradesToTextWhenCachedImageDisappears() throws Exception {
        prepareImage("gone.png");
        Execution execution = execution();
        ImageInjectionInterceptor interceptor = interceptor();
        List<Message> appended = new ArrayList<>();

        ToolExecuteResult result = read("gone.png", execution);
        interceptor.onAfterToolCall(context(execution), List.of(result));
        Path sessionDir = dataDir.resolve("images").resolve(String.valueOf(SESSION_ID));
        try (Stream<Path> files = Files.list(sessionDir)) {
            for (Path file : files.toList()) {
                Files.delete(file);
            }
        }
        interceptor.onBeforeModelInvoke(context(execution, appended));

        UserMessageEntity message = assertInstanceOf(UserMessageEntity.class, appended.getFirst());
        assertEquals(1, message.getContent().size());
        assertTrue(message.text().contains("不要臆测内容"));
    }

    private void injectOnce(ImageInjectionInterceptor interceptor, Execution execution,
                            List<Message> appended, String path) throws Exception {
        ToolExecuteResult result = read(path, execution);
        assertTrue(result.isSuccess(), () -> result.getToolOutput());
        interceptor.onAfterToolCall(context(execution), List.of(result));
        interceptor.onBeforeModelInvoke(context(execution, appended));
    }

    private ToolExecuteResult read(String path, Execution execution) throws Exception {
        ReadImageToolExecutor executor = new ReadImageToolExecutor(
                mapper, new ImageNormalizer(), cache());
        ToolExecuteResult result = executor.execute(ToolExecution.builder()
                .workspace(new LocalWorkspace("test", workspaceRoot.toString()))
                .args(mapper.writeValueAsString(ReadImageRequest.builder().path(path).build()))
                .attributes(execution.getAgentRequest().runtimeParametersOrDefault().getAttributes())
                .build());
        result.setToolSpecification(definition(ToolCatalog.READ_IMAGE));
        return result;
    }

    private ToolDefinition<ReadImageToolExecutor> definition(String name) {
        return ToolDefinition.<ReadImageToolExecutor>builder().name(name).id(name).maxOutput(400).timeout(20L)
                .executor(new ReadImageToolExecutor(mapper, new ImageNormalizer(), cache()))
                .build();
    }

    private ImageInjectionInterceptor interceptor() {
        return new ImageInjectionInterceptor(cache());
    }

    private ImageCacheDirectory cache() {
        return new ImageCacheDirectory(dataDir.toString());
    }

    private Execution execution() {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID));
        attributes.put(ExecutionAttributes.MODEL_VISION, true);
        AgentRequest request = AgentRequest.builder()
                .runtimeParameters(AgentRuntimeParameters.builder().attributes(Map.copyOf(attributes)).build())
                .build();
        return Execution.builder().id("exec-1").agentRequest(request).messages(new ArrayList<>()).build();
    }

    private LoopContext context(Execution execution) {
        return context(execution, new ArrayList<>());
    }

    private LoopContext context(Execution execution, List<Message> appended) {
        LoopMessages messages = LoopMessages.builder().execution(execution).build();
        return LoopContext.withCompactionCounter(messages, null, () -> 0, appended::addAll);
    }

    private void prepareImage(String name) throws IOException {
        BufferedImage image = new BufferedImage(32, 16, BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = image.createGraphics();
        try {
            graphics.setColor(Color.RED);
            graphics.fillRect(0, 0, 32, 16);
        } finally {
            graphics.dispose();
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        Files.write(workspaceRoot.resolve(name), output.toByteArray());
    }
}
