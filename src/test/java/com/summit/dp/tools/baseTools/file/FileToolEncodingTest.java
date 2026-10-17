package com.summit.dp.tools.baseTools.file;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.LocalWorkspaceBridge;
import com.summit.core.runtime.workspace.OsType;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.workflow.infrastructure.tools.arguments.EditFileRequest;
import com.summit.dp.workflow.infrastructure.tools.arguments.ReadFileRequest;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.read.ReadFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileHasher;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordStore;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileModificationException;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordRestorer;
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
    private final ObjectMapper mapper = new ObjectMapper();
    private final DefaultFileHasher hasher = new DefaultFileHasher();
    @TempDir Path root;

    @Test void wholeFileReadUsesUtf8WithGbkTerminal() throws Exception {
        assertReads(gbkWorkspace(), null, null, ORIGINAL);
    }

    @Test void lineRangeReadUsesUtf8WithGbkTerminal() throws Exception {
        assertReads(gbkWorkspace(), 1, 2, "\n末行🙂");
    }

    @Test void readUsesTheSelectedFileCapabilityWithoutRequiringAHostFile() throws Exception {
        Path remote = root.resolve("remote-only.txt");
        Workspace workspace = mock(Workspace.class);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        WorkspaceFiles files = mock(WorkspaceFiles.class);
        when(workspace.resolve("remote-only.txt")).thenReturn(remote);
        when(workspace.bridge()).thenReturn(bridge);
        when(bridge.files()).thenReturn(files);
        when(files.readString(remote, StandardCharsets.UTF_8)).thenReturn(ORIGINAL);
        ReadFileRequest request = ReadFileRequest.builder().path("remote-only.txt").build();

        ToolExecuteResult result = new ReadFileToolExecutor(mapper).execute(ToolExecution.builder()
                .workspace(workspace).args(mapper.writeValueAsString(request)).build());

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals(ORIGINAL, result.getToolOutput());
        assertFalse(Files.exists(remote));
        verify(files).readString(remote, StandardCharsets.UTF_8);
        verify(bridge, never()).commands();
    }

    @Test void editingExistingFileKeepsUtf8Bytes() throws Exception {
        assertEdits(gbkWorkspace(), true);
    }

    @Test void creatingFileKeepsCharactersOutsideGbk() throws Exception {
        assertEdits(gbkWorkspace(), false);
    }

    @Test void rollbackReadsAndWritesUtf8AndStillRejectsConflicts() throws Exception {
        assertRestores(gbkWorkspace());
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
        assertRestores(workspace);
    }

    private Workspace gbkWorkspace() {
        Workspace workspace = mock(Workspace.class);
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder().charset(Charset.forName("GBK"))
                .osType(OsType.WINDOWS).shellType(ShellType.CMD).isolated(true).build());
        when(workspace.bridge()).thenReturn(new LocalWorkspaceBridge(ShellType.CMD));
        when(workspace.resolve(anyString())).thenAnswer(call -> root.resolve((String) call.getArgument(0)));
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
        DefaultFileRecordManager manager = new DefaultFileRecordManager(new DefaultFileRecordStore(),
                new FileRecordRestorer(hasher), hasher);
        EditFileToolExecutor executor = new EditFileToolExecutor(mapper, new EditDiffer(), manager);
        EditFileRequest request = EditFileRequest.builder().path(name).type(existing ? "REPLACE" : "INSERT_AFTER")
                .oldText(existing ? "中文" : "").newText(existing ? "修改后🚀" : UPDATED).build();
        ToolExecuteResult result = executor.execute(ToolExecution.builder().workspace(workspace).executionId("encoding")
                .turnId("turn").args(mapper.writeValueAsString(request)).build());
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertArrayEquals(UPDATED.getBytes(StandardCharsets.UTF_8), Files.readAllBytes(file));
        FileRecord record = manager.listPendingRecords("encoding").getFirst();
        assertEquals(existing ? ORIGINAL : null, record.oldContent());
        assertEquals(UPDATED, record.newContent());
    }

    private void assertRestores(Workspace workspace) throws Exception {
        Path file = workspace.resolve("restore.txt");
        Files.writeString(file, UPDATED);
        FileRecord record = FileRecord.builder().id("encoding-record").filePath("restore.txt")
                .oldContent(ORIGINAL).newContent(UPDATED).newContentHash(hasher.hash(UPDATED)).build();
        FileRecordRestorer restorer = new FileRecordRestorer(hasher);
        restorer.restore(record, workspace);
        assertArrayEquals(ORIGINAL.getBytes(StandardCharsets.UTF_8), Files.readAllBytes(file));
        Files.writeString(file, "后续修改🙂");
        assertThrows(FileModificationException.class, () -> restorer.restore(record, workspace));
        assertEquals("后续修改🙂", Files.readString(file));
    }
}
