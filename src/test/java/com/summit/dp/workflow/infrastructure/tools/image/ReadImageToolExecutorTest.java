package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.workflow.infrastructure.tools.arguments.ReadImageRequest;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/** {@code read_image} 的边界、格式判定与字节读取口径。 */
class ReadImageToolExecutorTest {

    private static final String VISION_MODEL = "claude-opus-4-7";
    private static final long SESSION_ID = 42L;

    private final ObjectMapper mapper = new ObjectMapper();
    private final ImageNormalizer normalizer = new ImageNormalizer();
    @TempDir Path dataDir;
    @TempDir Path workspaceRoot;

    @Test
    void invalidArgumentsReturnFailures() throws Exception {
        for (String args : new String[]{"null", "{", "{}", "{\"path\":\"a\\u0000.png\"}"}) {
            ToolExecution execution = ToolExecution.builder().workspace(localWorkspace()).args(args).build();
            assertEquals("READ_FAILED", reason(executor().execute(execution)));
        }
        assertEquals("READ_FAILED", reason(executor().execute(ToolExecution.builder()
                .args("{\"path\":\"shot.png\"}").build())));
    }

    @Test
    void rejectsDirectoryLinkOutsideWorkspace() throws Exception {
        Path outside = Files.createDirectory(dataDir.resolve("outside"));
        Files.write(outside.resolve("secret.png"), png(8, 8));
        Path link = workspaceRoot.resolve("linked");
        linkDirectory(link, outside);
        try {
            assertEquals("OUTSIDE_WORKSPACE", reason(executor().execute(
                    execution(localWorkspace(), "linked/secret.png", VISION_MODEL))));
        } finally {
            Files.delete(link);
        }
    }

    @Test
    void allowsAWorkspaceWhoseRootIsADirectoryLink() throws Exception {
        Files.write(workspaceRoot.resolve("shot.png"), png(8, 8));
        Path alias = dataDir.resolve("workspace-alias");
        linkDirectory(alias, workspaceRoot);
        try {
            ToolExecuteResult result = executor().execute(execution(new LocalWorkspace("alias", alias.toString()), "shot.png", VISION_MODEL));
            assertTrue(result.isSuccess(), result.getToolOutput());
        } finally {
            Files.delete(alias);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"gif", "bmp"})
    void convertedFormatMatchesTheActualBytes(String format) throws Exception {
        BufferedImage source = new BufferedImage(8, 8, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        assertTrue(ImageIO.write(source, format, bytes));
        ImageNormalizer.NormalizedImage normalized = normalizer.normalize(bytes.toByteArray(), ImageFormat.detect(bytes.toByteArray()));
        assertEquals("image/png", normalized.mimeType());
        assertEquals("png", normalized.extension());
        assertEquals(ImageFormat.PNG, ImageFormat.detect(normalized.data()));
        assertEquals(8, ImageIO.read(new ByteArrayInputStream(normalized.data())).getWidth());
    }

    @Test
    void rejectsTruncatedPixelsEvenWhenTheSizeHeaderIsReadable() throws Exception {
        byte[] truncated = Arrays.copyOf(png(8, 8), 33);
        assertEquals(new ImageNormalizer.ImageSize(8, 8), normalizer.probe(truncated));
        Files.write(workspaceRoot.resolve("broken.png"), truncated);
        assertEquals("READ_FAILED", reason(executor().execute(execution(localWorkspace(), "broken.png", VISION_MODEL))));
    }

    @Test
    void checksTheActualBridgePayloadSizeAsWellAsTheHostSize() throws Exception {
        Path image = workspaceRoot.resolve("growing.png");
        Files.write(image, png(8, 8));
        Workspace workspace = mock(Workspace.class);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        WorkspaceFiles files = mock(WorkspaceFiles.class);
        when(workspace.resolve("growing.png")).thenReturn(image);
        when(workspace.encloses(any())).thenReturn(true);
        when(workspace.bridge()).thenReturn(bridge);
        when(bridge.files()).thenReturn(files);
        when(files.readBytes(image)).thenReturn(new byte[(int) ReadImageToolExecutor.MAX_BYTES + 1]);
        assertEquals("FILE_TOO_LARGE", reason(executor().execute(execution(workspace, "growing.png", VISION_MODEL))));
    }

    @Test
    void exhaustedBudgetStopsBeforeImageDecoding() throws Exception {
        ToolExecution execution = execution(localWorkspace(), "unused.png", VISION_MODEL);
        Map<String, Object> attributes = new HashMap<>(execution.getAttributes());
        attributes.put(ReadImageToolExecutor.KEY_CONSUMED, 4);
        execution.setAttributes(attributes);
        assertEquals("BUDGET_EXHAUSTED", reason(executor().execute(execution)));
    }

    @Test
    void readsBytesNotDecodedString() throws Exception {
        Path image = workspaceRoot.resolve("shot.png");
        Files.write(image, png(64, 48));
        // 金丝雀：这份素材确实是二进制，按字符集读会直接失败 —— 否则本用例证明不了任何事。
        assertThrows(IOException.class, () -> Files.readString(image, StandardCharsets.UTF_8));

        ToolExecuteResult result = executor().execute(execution(localWorkspace(), "shot.png", VISION_MODEL));

        assertTrue(result.isSuccess(), () -> result.getToolOutput());
        JsonNode receipt = mapper.readTree(result.getToolOutput());
        assertEquals(64, receipt.at("/images/0/width").asInt());
        assertEquals(48, receipt.at("/images/0/height").asInt());
        String imageId = receipt.at("/images/0/imageId").asText();
        Path cached = dataDir.resolve("images").resolve(String.valueOf(SESSION_ID)).resolve(imageId + ".png");
        assertTrue(Files.isRegularFile(cached), () -> "缓存文件不存在: " + cached);
    }

    @Test
    void rejectsPathOutsideWorkspace() throws Exception {
        Workspace workspace = mock(Workspace.class);
        Path outside = workspaceRoot.getParent().resolve("outside.png");
        when(workspace.resolve("../outside.png")).thenReturn(outside);
        when(workspace.encloses(outside)).thenReturn(false);

        ToolExecuteResult result = executor().execute(execution(workspace, "../outside.png", VISION_MODEL));

        assertFalse(result.isSuccess());
        assertEquals("OUTSIDE_WORKSPACE", reason(result));
    }

    @Test
    void sniffsMagicInsteadOfExtension() throws Exception {
        Files.writeString(workspaceRoot.resolve("fake.png"), "not an image at all", StandardCharsets.UTF_8);

        ToolExecuteResult result = executor().execute(execution(localWorkspace(), "fake.png", VISION_MODEL));

        assertFalse(result.isSuccess());
        assertEquals("NOT_AN_IMAGE", reason(result));
    }

    @Test
    void reportsUnsupportedFormatInsteadOfCallingItNotAnImage() throws Exception {
        byte[] webp = new byte[16];
        System.arraycopy("RIFF".getBytes(StandardCharsets.US_ASCII), 0, webp, 0, 4);
        System.arraycopy("WEBP".getBytes(StandardCharsets.US_ASCII), 0, webp, 8, 4);
        Files.write(workspaceRoot.resolve("photo.webp"), webp);

        ToolExecuteResult result = executor().execute(execution(localWorkspace(), "photo.webp", VISION_MODEL));

        assertFalse(result.isSuccess());
        assertEquals("UNSUPPORTED_FORMAT", reason(result));
    }

    @Test
    void rejectsPixelBombBeforeDecoding() throws Exception {
        Files.write(workspaceRoot.resolve("huge.png"), png(8, 8));
        ImageNormalizer oversized = mock(ImageNormalizer.class);
        when(oversized.probe(any())).thenReturn(new ImageNormalizer.ImageSize(30_000, 30_000));
        ReadImageToolExecutor executor = new ReadImageToolExecutor(
                mapper, oversized, new ImageCacheDirectory(dataDir.toString()), vision());

        ToolExecuteResult result = executor.execute(execution(localWorkspace(), "huge.png", VISION_MODEL));

        assertFalse(result.isSuccess());
        assertEquals("PIXEL_BOMB", reason(result));
        verify(oversized, never()).normalize(any(), any());
    }

    @Test
    void refusesNonVisionModel() throws Exception {
        Files.write(workspaceRoot.resolve("shot.png"), png(8, 8));

        ToolExecuteResult result = executor().execute(execution(localWorkspace(), "shot.png", "deepseek-flash"));

        assertFalse(result.isSuccess());
        assertEquals("VISION_UNAVAILABLE", reason(result));
    }

    @Test
    void sandboxUnreadableIsReportedNotThrown() throws Exception {
        // 宿主上文件存在（size 判得出来），但桥接读取失败 —— 这才是沙箱路径映射失配的真实形态。
        Path image = workspaceRoot.resolve("remote.png");
        Files.write(image, png(8, 8));
        Workspace workspace = mock(Workspace.class);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        WorkspaceFiles files = mock(WorkspaceFiles.class);
        when(workspace.resolve("remote.png")).thenReturn(image);
        when(workspace.encloses(image)).thenReturn(true);
        when(workspace.bridge()).thenReturn(bridge);
        when(bridge.files()).thenReturn(files);
        when(files.readBytes(image)).thenThrow(new IOException("MXC file operation failed"));

        ToolExecuteResult result = executor().execute(execution(workspace, "remote.png", VISION_MODEL));

        assertFalse(result.isSuccess());
        assertEquals("SANDBOX_UNREADABLE", reason(result));
    }

    @Test
    void downscalesWhenLongEdgeExceedsLimit() throws Exception {
        ImageNormalizer.NormalizedImage normalized = normalizer.normalize(png(4000, 100), ImageFormat.PNG);

        assertEquals(ImageNormalizer.MAX_LONG_EDGE, normalized.width());
        assertEquals(39, normalized.height());
        assertEquals("png", normalized.extension());
    }

    private ReadImageToolExecutor executor() {
        return new ReadImageToolExecutor(mapper, normalizer, new ImageCacheDirectory(dataDir.toString()), vision());
    }

    private void linkDirectory(Path link, Path target) throws Exception {
        if (System.getProperty("os.name").toLowerCase().contains("win")) {
            Process junction = new ProcessBuilder("cmd.exe", "/c", "mklink", "/J", link.toString(), target.toString())
                    .redirectErrorStream(true).start();
            String output = new String(junction.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertEquals(0, junction.waitFor(), output);
        } else {
            Files.createSymbolicLink(link, target);
        }
    }

    private VisionCapabilityResolver vision() {
        return new VisionCapabilityResolver("claude-*");
    }

    private Workspace localWorkspace() {
        return new LocalWorkspace("test-workspace", workspaceRoot.toString());
    }

    private ToolExecution execution(Workspace workspace, String path, String modelName) throws Exception {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID));
        attributes.put(ExecutionAttributes.MODEL_NAME, modelName);
        return ToolExecution.builder()
                .workspace(workspace)
                .args(mapper.writeValueAsString(ReadImageRequest.builder().path(path).build()))
                .attributes(Map.copyOf(attributes))
                .build();
    }

    private String reason(ToolExecuteResult result) throws Exception {
        return mapper.readTree(result.getToolOutput()).path("reason").asText();
    }

    private static byte[] png(int width, int height) throws IOException {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = image.createGraphics();
        try {
            graphics.setColor(Color.BLUE);
            graphics.fillRect(0, 0, width, height);
        } finally {
            graphics.dispose();
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        return output.toByteArray();
    }
}
