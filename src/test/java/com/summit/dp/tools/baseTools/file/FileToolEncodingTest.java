package com.summit.dp.tools.baseTools.file;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.*;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.workflow.infrastructure.tools.arguments.EditFileRequest;
import com.summit.dp.workflow.infrastructure.tools.arguments.ReadFileRequest;
import com.summit.dp.workflow.infrastructure.tools.arguments.WriteFileRequest;
import com.summit.dp.workflow.infrastructure.tools.file.FileEditRecorder;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.read.ReadFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.record.*;
import com.summit.dp.workflow.infrastructure.tools.file.write.WriteFileToolExecutor;
import com.summit.sandbox.windows.WindowsWorkspaceProvider;
import com.summit.sandbox.windows.WindowsWorkspaceSpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
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
        // 边界复核走接口默认实现（resolveInside），普通 mock 会把它打成 null，
        // 于是 readBytes 收到 null、断言只剩一句「读取文件失败」。
        Workspace workspace = mock(Workspace.class, CALLS_REAL_METHODS);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        WorkspaceFiles files = mock(WorkspaceFiles.class);
        when(workspace.workDir()).thenReturn(root.toAbsolutePath().normalize().toString());
        when(workspace.resolve("remote-only.txt")).thenReturn(remote);
        doReturn(bridge).when(workspace).bridge();
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
        assertEdits(gbkWorkspace());
    }

    @Test void creatingFileKeepsCharactersOutsideGbk() throws Exception {
        assertCreates(gbkWorkspace());
    }

    @Test void recordedDiffReplaysBackToUtf8Content() throws Exception {
        assertDiffReplayKeepsUtf8();
    }

    /**
     * 真实 Windows 沙箱里跑一遍文件工具链。
     *
     * <p>只在 Windows 上跑：{@code WindowsWorkspaceProvider} 要改 ACL、建受限令牌，别的平台直接抛错——
     * 让它去 Linux CI 上红着没有意义。</p>
     */
    @Test
    @EnabledOnOs(OS.WINDOWS)
    void nativeSandboxFileToolsPreserveUtf8AlongsideCmdOutput() throws Exception {
        Path project = Files.createDirectories(root.resolve("project"));
        Workspace workspace = new WindowsWorkspaceProvider().resolve(new WindowsWorkspaceSpec(project.toString()));
        assertTrue(workspace.runtimeEnvironment().isolated());
        System.out.println("沙箱终端编码: " + workspace.runtimeEnvironment().charset());
        // 这里刻意用 ASCII：cmd 的内建命令在 chcp 生效前就把命令行按 ANSI 代码页转成字节了
        // （见框架 ShellType.CMD 的注释），中文参数用 UTF-8 解码必然出替换字符。
        // 「中文不乱码」由下面的文件工具断言负责，那才是本用例要守的东西。
        assertTrue(workspace.bridge().commands().execute("echo sandbox-alive", workspace.workDir(),
                        workspace.runtimeEnvironment().charset(), 10, TimeUnit.SECONDS, 4096)
                .output().contains("sandbox-alive"));
        assertReads(workspace, null, null, ORIGINAL_NUMBERED);
        assertReads(workspace, 2, 3, "2: \n3: 末行🙂");
        assertEdits(workspace);
        assertCreates(workspace);
        assertDiffReplayKeepsUtf8();
    }

    private Workspace gbkWorkspace() {
        // 边界判定就在接口默认方法里（resolveInside → enclosesReal）：普通 mock 会把它们打成 null，
        // 工作区内的写入直接 NPE；bridge() 用 doReturn 打桩，避免 when() 先把真实默认实现跑一遍。
        Workspace workspace = mock(Workspace.class, CALLS_REAL_METHODS);
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder().charset(Charset.forName("GBK"))
                .osType(OsType.WINDOWS).shellType(ShellType.CMD).isolated(true).build());
        when(workspace.workDir()).thenReturn(root.toAbsolutePath().normalize().toString());
        doReturn(new LocalWorkspaceBridge(ShellType.CMD)).when(workspace).bridge();
        when(workspace.resolve(anyString())).thenAnswer(call ->
                root.resolve((String) call.getArgument(0)).normalize());
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

    private void assertEdits(Workspace workspace) throws Exception {
        Path file = workspace.resolve("existing.txt");
        Files.writeString(file, ORIGINAL);
        DefaultFileRecordManager manager = new DefaultFileRecordManager(new InMemoryFileRecordStore());
        EditFileToolExecutor executor = new EditFileToolExecutor(mapper, new FileEditRecorder(new EditDiffer(), manager));
        EditFileRequest request = EditFileRequest.builder().path("existing.txt").type("REPLACE")
                .oldText("中文").newText("修改后🚀").build();
        ToolExecuteResult result = executor.execute(ToolExecution.builder().workspace(workspace).executionId("encoding")
                .turnId("turn").args(mapper.writeValueAsString(request)).build());
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertArrayEquals(UPDATED.getBytes(StandardCharsets.UTF_8), Files.readAllBytes(file));
        assertRecorded(manager, ORIGINAL);
    }

    /** 新建归 write_file：编码同样不能在进程 GBK 终端下损坏。 */
    private void assertCreates(Workspace workspace) throws Exception {
        Path file = workspace.resolve("created.txt");
        DefaultFileRecordManager manager = new DefaultFileRecordManager(new InMemoryFileRecordStore());
        WriteFileToolExecutor executor = new WriteFileToolExecutor(mapper,
                new FileEditRecorder(new EditDiffer(), manager));
        WriteFileRequest request = WriteFileRequest.builder().path("created.txt").type("CREATE")
                .content(UPDATED).build();
        ToolExecuteResult result = executor.execute(ToolExecution.builder().workspace(workspace).executionId("encoding")
                .turnId("turn").args(mapper.writeValueAsString(request)).build());
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertArrayEquals(UPDATED.getBytes(StandardCharsets.UTF_8), Files.readAllBytes(file));
        assertRecorded(manager, null);
    }

    private void assertRecorded(DefaultFileRecordManager manager, String expectedBaseline) {
        FileRecord record = manager.listRecords("encoding").getFirst();
        // 记录只留基线与差异：基线必须还是改动前的原文，差异重放后要能还原出改动后的原文。
        // 重放按行拼接（换行统一成 \n），与差异生成侧的行切分口径一致，所以这里也按归一化后比较。
        assertEquals(expectedBaseline, record.baseline());
        assertEquals(UPDATED.replace("\r\n", "\n"),
                UnifiedDiffReplayer.replay(record.baseline(), List.of(record.diff())).orElseThrow());
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
