package com.summit.dp.tools.baseTools.file;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.*;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.workflow.infrastructure.tools.arguments.EditFileRequest;
import com.summit.dp.workflow.infrastructure.tools.arguments.ReadFileRequest;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.read.ReadFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.record.*;
import com.summit.sandbox.mxc.MxcRuntime;
import com.summit.sandbox.mxc.MxcWorkspaceProvider;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.Mockito.*;

/** 文件编码不能继承 Windows 终端的 GBK，否则读取、编辑和回滚会同时损坏内容。 */
class FileToolEncodingTest {
    private static final String ORIGINAL = "中文\r\n\r\n末行🙂";
    private static final String UPDATED = "修改后🚀\r\n\r\n末行🙂";
    /** 行号换成 1 基后：行号与正文成对输出，模型据此回读同一段。 */
    private static final String ORIGINAL_NUMBERED = "1: 中文\n2: \n3: 末行🙂";
    private final ObjectMapper mapper = new ObjectMapper();
    private final EditDiffer differ = new EditDiffer();
    @TempDir Path root;

    @Test void wholeFileReadUsesUtf8WithGbkTerminal() throws Exception {
        assertReads(gbkWorkspace(), null, null, ORIGINAL_NUMBERED);
    }

    @Test void lineRangeReadUsesUtf8WithGbkTerminal() throws Exception {
        assertReads(gbkWorkspace(), 1, 2, "1: 中文\n2: ");
    }

    @Test void readUsesTheSelectedFileCapabilityWithoutRequiringAHostFile() throws Exception {
        Path remote = root.resolve("remote-only.txt");
        Workspace workspace = mock(Workspace.class);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        WorkspaceFiles files = mock(WorkspaceFiles.class);
        when(workspace.resolve("remote-only.txt")).thenReturn(remote);
        when(workspace.bridge()).thenReturn(bridge);
        when(bridge.files()).thenReturn(files);
        when(files.readBytes(remote)).thenReturn(ORIGINAL.getBytes(StandardCharsets.UTF_8));
        ReadFileRequest request = ReadFileRequest.builder().path("remote-only.txt").build();

        ToolExecuteResult result = new ReadFileToolExecutor(mapper).execute(ToolExecution.builder()
                .workspace(workspace).args(mapper.writeValueAsString(request)).build());

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals(ORIGINAL_NUMBERED, result.getToolOutput());
        assertFalse(Files.exists(remote));
        verify(files).readBytes(remote);
        verify(bridge, never()).commands();
    }

    @Test void editingExistingFileKeepsUtf8Bytes() throws Exception {
        assertEdits(gbkWorkspace(), true);
    }

    @Test void creatingFileKeepsCharactersOutsideGbk() throws Exception {
        assertEdits(gbkWorkspace(), false);
    }

    @Test void recordedDiffReplaysBackToUtf8Content() throws Exception {
        assertDiffReplayKeepsUtf8();
    }

    @Test void nativeSandboxFileToolsPreserveUtf8AlongsideCmdOutput() throws Exception {
        String node = System.getProperty("mxc.node");
        String sdk = System.getProperty("mxc.sdk");
        String base = System.getProperty("mxc.business.root");
        assumeTrue(node != null && sdk != null && base != null, "需要显式 MXC 运行资源");
        Path directory = Files.createDirectories(Path.of(base, "encoding-" + UUID.randomUUID()));
        Path project = Files.createDirectories(directory.resolve("project"));
        MxcRuntime runtime = MxcRuntime.nativeHost(Path.of(node), Path.of(sdk), directory.resolve("helpers"));
        Workspace workspace = new MxcWorkspaceProvider(runtime).resolve(new MxcWorkspaceSpec(project.toString()));
        assertTrue(workspace.runtimeEnvironment().isolated());
        System.out.println("沙箱终端编码: " + workspace.runtimeEnvironment().charset());
        if (runtime.windows()) {
            assertTrue(workspace.bridge().commands().execute("echo 中文", workspace.workDir(), workspace.runtimeEnvironment().charset(),
                    10, TimeUnit.SECONDS, 4096).output().contains("中文"));
        }
        assertReads(workspace, null, null, ORIGINAL);
        assertReads(workspace, 1, 2, "\n末行🙂");
        assertEdits(workspace, true);
        assertEdits(workspace, false);
        assertDiffReplayKeepsUtf8();
    }

    private Workspace gbkWorkspace() {
        Workspace workspace = mock(Workspace.class);
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder().charset(Charset.forName("GBK"))
                .osType(OsType.WINDOWS).shellType(ShellType.CMD).isolated(true).build());
        when(workspace.bridge()).thenReturn(new LocalWorkspaceBridge(ShellType.CMD));
        when(workspace.resolve(anyString())).thenAnswer(call -> root.resolve((String) call.getArgument(0)));
        // 边界判定与真实实现的几何一致：不 stub 就只能拿到 false，工作区内的写入会被当成越界。
        when(workspace.encloses(any(Path.class))).thenAnswer(call ->
                ((Path) call.getArgument(0)).toAbsolutePath().normalize()
                        .startsWith(root.toAbsolutePath().normalize()));
        return workspace;
    }

    private void assertReads(Workspace workspace, Integer start, Integer end, String expected) throws Exception {
        Path file = workspace.resolve("read.txt");
        Files.writeString(file, ORIGINAL);
        ReadFileRequest request = ReadFileRequest.builder().path("read.txt").startLine(start).endLine(end).build();
        ToolExecuteResult result = new ReadFileToolExecutor(mapper).execute(ToolExecution.builder().workspace(workspace)
                .args(mapper.writeValueAsString(request)).build());
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals(expected, result.getToolOutput());
    }

    private void assertEdits(Workspace workspace, boolean existing) throws Exception {
        String name = existing ? "existing.txt" : "created.txt";
        Path file = workspace.resolve(name);
        if (existing) Files.writeString(file, ORIGINAL);
        DefaultFileRecordManager manager = new DefaultFileRecordManager(new InMemoryFileRecordStore());
        EditFileToolExecutor executor = new EditFileToolExecutor(mapper, new EditDiffer(), manager);
        EditFileRequest request = EditFileRequest.builder().path(name).type(existing ? "REPLACE" : "INSERT_AFTER")
                .oldText(existing ? "中文" : "").newText(existing ? "修改后🚀" : UPDATED).build();
        ToolExecuteResult result = executor.execute(ToolExecution.builder().workspace(workspace).executionId("encoding")
                .turnId("turn").args(mapper.writeValueAsString(request)).build());
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertArrayEquals(UPDATED.getBytes(StandardCharsets.UTF_8), Files.readAllBytes(file));
        FileRecord record = manager.listRecords("encoding").getFirst();
        // 记录只留基线与差异：基线必须还是编辑前的原文，差异重放后要能还原出编辑后的原文。
        // 重放按行拼接（换行统一成 \n），与差异生成侧的行切分口径一致，所以这里也按归一化后比较。
        assertEquals(existing ? ORIGINAL : null, record.baseline());
        assertEquals(UPDATED.replace("\r\n", "\n"),
                UnifiedDiffReplayer.replay(record.baseline(), java.util.List.of(record.diff())).orElseThrow());
    }

    /** 差异重放是纯文本操作：只要两侧内容按 UTF-8 读入，GBK 环境不会影响重建结果。 */
    private void assertDiffReplayKeepsUtf8() {
        DiffResult diff = differ.diff("restore.txt", ORIGINAL, UPDATED);
        FileRecord record = FileRecord.builder().filePath("restore.txt")
                .baseline(ORIGINAL).diff(diff.unifiedDiff())
                .plusLines(diff.plusLines()).minusLines(diff.minusLines()).build();
        assertEquals(UPDATED.replace("\r\n", "\n"), UnifiedDiffReplayer.replay(record.baseline(),
                java.util.List.of(record.diff())).orElseThrow());
        assertEquals(1, record.plusLines());
        assertEquals(1, record.minusLines());
    }
}
