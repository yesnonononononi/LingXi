package com.summit.dp.tools.baseTools.file;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.LocalWorkspaceBridge;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.workflow.infrastructure.tools.arguments.DeleteFileRequest;
import com.summit.dp.workflow.infrastructure.tools.arguments.ReadFileRequest;
import com.summit.dp.workflow.infrastructure.tools.arguments.SearchFilesRequest;
import com.summit.dp.workflow.infrastructure.tools.file.delete.DeleteFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.read.ReadFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.search.SearchFilesToolExecutor;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 文件工具的契约：行号与行参同一口径、二进制快速失败、检索可裁剪、删除不越界。 */
class FileToolContractTest {
    private final ObjectMapper mapper = new ObjectMapper();
    @TempDir Path root;

    @Test void readFileNumbersLinesOneBasedAndHonoursTheRange() throws Exception {
        Files.writeString(root.resolve("sample.txt"), "alpha\nbeta\ngamma\n");

        ToolExecuteResult whole = read(ReadFileRequest.builder().path("sample.txt").build());
        assertTrue(whole.isSuccess(), whole.getToolOutput());
        assertEquals("1: alpha\n2: beta\n3: gamma", whole.getToolOutput());

        ToolExecuteResult middle = read(ReadFileRequest.builder().path("sample.txt").startLine(2).endLine(2).build());
        assertTrue(middle.isSuccess(), middle.getToolOutput());
        assertEquals("2: beta", middle.getToolOutput(), "行号必须与行参同一口径，否则回读会整体错一行");
    }

    @Test void readFileRejectsBinaryBeforeDecoding() throws Exception {
        Files.write(root.resolve("blob.bin"), new byte[]{'a', 0, 'b'});

        ToolExecuteResult result = read(ReadFileRequest.builder().path("blob.bin").build());

        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("二进制"), result.getToolOutput());
    }

    @Test void readFileRejectsNonUtf8InsteadOfReplacingCharacters() throws Exception {
        Files.write(root.resolve("gbk.txt"), "中文".getBytes(Charset.forName("GBK")));

        ToolExecuteResult result = read(ReadFileRequest.builder().path("gbk.txt").build());

        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("UTF-8"), result.getToolOutput());
    }

    @Test void readFileReportsTheSizeWhenTheStartLineIsPastTheEnd() throws Exception {
        Files.writeString(root.resolve("short.txt"), "only\n");

        ToolExecuteResult result = read(ReadFileRequest.builder().path("short.txt").startLine(9).build());

        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("共 1 行"), result.getToolOutput());
    }

    @Test void emptyFileReadsAsEmptyContent() throws Exception {
        Files.writeString(root.resolve("empty.txt"), "");

        ToolExecuteResult result = read(ReadFileRequest.builder().path("empty.txt").build());

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals("", result.getToolOutput());
    }

    @Test void searchReportsPathAndLineAndSkipsVendorDirectories() throws Exception {
        Files.writeString(root.resolve("App.java"), "class App {}\n// helper\n");
        Files.createDirectories(root.resolve("node_modules/dep"));
        Files.writeString(root.resolve("node_modules/dep/index.js"), "helper\n");

        ToolExecuteResult result = search(SearchFilesRequest.builder().pattern("helper").build());

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals("App.java:2: // helper", result.getToolOutput(),
                "依赖目录必须被剪掉，行号必须是 1 基");
    }

    @Test void searchHonoursGlobAndSaysSoWhenTheLimitIsReached() throws Exception {
        Files.writeString(root.resolve("A.java"), "helper\n");
        Files.writeString(root.resolve("B.js"), "helper\nhelper\n");

        ToolExecuteResult javaOnly = search(SearchFilesRequest.builder().pattern("helper").glob("*.java").build());
        assertTrue(javaOnly.isSuccess(), javaOnly.getToolOutput());
        assertEquals("A.java:1: helper", javaOnly.getToolOutput());

        ToolExecuteResult limited = search(SearchFilesRequest.builder().pattern("helper").maxResults(1).build());
        assertTrue(limited.isSuccess(), limited.getToolOutput());
        assertTrue(limited.getToolOutput().startsWith("A.java:1: helper"), limited.getToolOutput());
        assertTrue(limited.getToolOutput().contains("已达返回上限"), "截断必须显式说出来");
    }

    @Test void searchRejectsPathsOutsideTheWorkspace() throws Exception {
        Files.writeString(root.resolve("inside.txt"), "needle\n");

        ToolExecuteResult result = search(SearchFilesRequest.builder().pattern("needle").path("..").build());

        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("工作区内"), result.getToolOutput());
    }

    @Test void deleteFileRemovesTheFileAndReportsIt() throws Exception {
        Path target = root.resolve("drop.txt");
        Files.writeString(target, "bye");

        ToolExecuteResult result = delete(DeleteFileRequest.builder().path("drop.txt").build());

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertFalse(Files.exists(target), "删完必须真的不在了");
        assertTrue(result.getToolOutput().contains("\"deleted\":true"), result.getToolOutput());
    }

    @Test void deleteFileRefusesDirectoriesAndMissingPaths() throws Exception {
        Files.createDirectories(root.resolve("folder"));

        ToolExecuteResult directory = delete(DeleteFileRequest.builder().path("folder").build());
        assertFalse(directory.isSuccess());
        assertTrue(directory.getToolOutput().contains("不接受目录"), directory.getToolOutput());

        ToolExecuteResult missing = delete(DeleteFileRequest.builder().path("absent.txt").build());
        assertFalse(missing.isSuccess());
        assertTrue(missing.getToolOutput().contains("不存在"), missing.getToolOutput());
    }

    @Test void deleteFileRejectsPathsOutsideTheWorkspace() throws Exception {
        Path outside = root.getParent().resolve("outside-delete-target.txt");
        Files.writeString(outside, "keep");
        try {
            ToolExecuteResult result = delete(DeleteFileRequest.builder()
                    .path("../" + outside.getFileName()).build());

            assertFalse(result.isSuccess());
            assertTrue(result.getToolOutput().contains("工作区内"), result.getToolOutput());
            assertTrue(Files.exists(outside), "越界删除必须在落盘前被拦住");
        } finally {
            Files.deleteIfExists(outside);
        }
    }

    private ToolExecuteResult read(ReadFileRequest request) throws Exception {
        return new ReadFileToolExecutor(mapper).execute(ToolExecution.builder()
                .workspace(workspace()).args(mapper.writeValueAsString(request)).build());
    }

    private ToolExecuteResult search(SearchFilesRequest request) throws Exception {
        return new SearchFilesToolExecutor(mapper).execute(ToolExecution.builder()
                .workspace(workspace()).args(mapper.writeValueAsString(request)).build());
    }

    private ToolExecuteResult delete(DeleteFileRequest request) throws Exception {
        return new DeleteFileToolExecutor(mapper).execute(ToolExecution.builder()
                .workspace(workspace()).args(mapper.writeValueAsString(request)).build());
    }

    /** 边界判定按真实几何实现：stub 成常量会让越界用例假绿。 */
    private Workspace workspace() {
        // 必须走真实的默认方法：resolveInside / enclosesReal 的边界判定就在接口默认实现里，
        // 用普通 mock 会把它们打成 null，越界用例变假绿、正常用例直接 NPE。
        Workspace workspace = mock(Workspace.class, CALLS_REAL_METHODS);
        when(workspace.workDir()).thenReturn(root.toAbsolutePath().normalize().toString());
        when(workspace.resolve(anyString())).thenAnswer(call ->
                root.resolve((String) call.getArgument(0)).normalize());
        // doReturn 才绕得开真实默认实现：when(...) 会先把 bridge() 真跑一遍，
        // 而 mock 的 runtimeEnvironment() 是 null，直接在打桩阶段 NPE。
        doReturn(new LocalWorkspaceBridge(ShellType.CMD)).when(workspace).bridge();
        return workspace;
    }
}
