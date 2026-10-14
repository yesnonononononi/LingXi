package com.summit.dp.workspace;

import com.summit.core.runtime.workspace.Workspace;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workspace.application.service.SandboxServiceInstaller;
import com.summit.dp.workspace.application.vo.SandboxServiceStatus;
import com.summit.dp.workspace.infrastructure.config.SandboxProperties;
import com.summit.runtime.workspace.LocalWorkspace;
import com.summit.sandbox.CommandTimeoutConfig;
import com.summit.sandbox.SandboxInitializer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 沙箱服务检测与安装的行为守卫。
 *
 * <p>这里最要紧的两条：**缺 srt 包时一次命令都不许跑**（否则用户拿到的是英文异常而不是「缺哪个文件」），
 * 以及 **自动安装最多一次**（安装会弹 UAC，每轮请求重弹无法接受）。</p>
 *
 * <p>平台相关的用例按 OS 分流：非 Windows 上不存在安装这一步，Windows 上才谈得上装。</p>
 */
class SandboxServiceInstallerTest {

    @TempDir
    Path temp;

    @Test
    @DisplayName("缺 srt-cli：直接报清缺哪个文件，一次命令都不跑")
    void missingSrtCliFailsBeforeAnyCommand() {
        Fixture fixture = fixture(temp.resolve("not-there/cli.js"), null, true, true);

        ClientException failure = assertThrows(ClientException.class, () -> fixture.installer().ensureReady());

        assertTrue(failure.getMessage().contains("srt-cli"), failure.getMessage());
        assertTrue(fixture.recorder().calls.isEmpty(), "连探测都不该跑：" + fixture.recorder().calls);
    }

    @Test
    @DisplayName("缺 node-exe：同样在跑命令之前就拦下")
    void missingNodeFailsBeforeAnyCommand() throws IOException {
        Path srtCli = Files.createFile(Files.createDirectories(temp.resolve("resources")).resolve("cli.js"));
        Fixture fixture = fixture(srtCli, temp.resolve("not-there/node.exe"), true, true);

        ClientException failure = assertThrows(ClientException.class, () -> fixture.installer().ensureReady());

        assertTrue(failure.getMessage().contains("node-exe"), failure.getMessage());
        assertTrue(fixture.recorder().calls.isEmpty(), "连探测都不该跑：" + fixture.recorder().calls);
    }

    @Test
    @DisplayName("状态查询只做文件检测，不跑任何命令")
    void inspectNeverRunsCommands() {
        Fixture fixture = fixture(null, null, true, true);

        SandboxServiceStatus status = fixture.installer().inspect();

        assertTrue(status.srtPackagePresent());
        assertFalse(status.installedThisCall());
        assertTrue(fixture.recorder().calls.isEmpty(), "inspect 不该启动子进程：" + fixture.recorder().calls);
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    @DisplayName("Windows：探测通过就不安装（绝大多数情况不该打扰用户）")
    void windowsProbeSuccessSkipsInstallation() {
        Fixture fixture = fixture(null, null, true, true);

        SandboxServiceStatus status = fixture.installer().ensureReady();

        assertEquals(List.of("init"), fixture.recorder().calls);
        assertTrue(status.windows());
        assertFalse(status.installedThisCall());
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    @DisplayName("Windows：探测不过就装一次，装完即视为就绪")
    void windowsProbeFailureInstallsOnce() {
        Fixture fixture = fixture(null, null, false, true);

        SandboxServiceStatus status = fixture.installer().ensureReady();

        assertEquals(List.of("init", "installWindows"), fixture.recorder().calls);
        assertTrue(status.installedThisCall());
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    @DisplayName("Windows：安装失败（例如 UAC 被取消）要把框架诊断带出来，不能只说「失败」")
    void windowsInstallFailureKeepsDiagnostics() {
        Fixture fixture = fixture(null, null, false, false);

        ClientException failure = assertThrows(ClientException.class, () -> fixture.installer().ensureReady());

        assertTrue(failure.getMessage().contains("UAC"), failure.getMessage());
        assertEquals(List.of("init", "installWindows"), fixture.recorder().calls);
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    @DisplayName("Windows：自动安装失败后不再自动重试，改为提示手动安装")
    void automaticInstallIsNotRetriedAfterFailure() {
        Fixture fixture = fixture(null, null, false, false);

        assertThrows(ClientException.class, () -> fixture.installer().ensureReady());
        ClientException second = assertThrows(ClientException.class, () -> fixture.installer().ensureReady());

        assertTrue(second.getMessage().contains("设置"), second.getMessage());
        assertEquals(1, fixture.recorder().calls.stream().filter("installWindows"::equals).count(),
                "自动安装只能尝试一次，否则每轮请求都会弹 UAC：" + fixture.recorder().calls);
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    @DisplayName("Windows：确认就绪后不再重复探测")
    void ensuredStateIsCachedForTheProcess() {
        Fixture fixture = fixture(null, null, true, true);

        fixture.installer().ensureReady();
        fixture.installer().ensureReady();

        assertEquals(List.of("init"), fixture.recorder().calls);
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    @DisplayName("Windows：显式安装不先探测，直接执行 windows-install")
    void explicitInstallRunsTheWindowsInstallCommand() {
        Fixture fixture = fixture(null, null, false, true);

        SandboxServiceStatus status = fixture.installer().install();

        assertEquals(List.of("installWindows"), fixture.recorder().calls);
        assertTrue(status.installedThisCall());
        assertTrue(status.message().contains("安装完成"), status.message());
    }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    @DisplayName("非 Windows：不存在安装这一步，也不该跑任何命令")
    void nonWindowsNeedsNoInstallation() {
        Fixture fixture = fixture(null, null, true, true);

        SandboxServiceStatus status = fixture.installer().ensureReady();

        assertFalse(status.windows());
        assertFalse(status.installedThisCall());
        assertTrue(status.message().contains("不需要安装"), status.message());
        assertTrue(fixture.recorder().calls.isEmpty(), "不该启动子进程：" + fixture.recorder().calls);
    }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    @DisplayName("非 Windows：显式安装也如实说「不需要」，不假装装过")
    void nonWindowsExplicitInstallIsHonest() {
        Fixture fixture = fixture(null, null, true, true);

        SandboxServiceStatus status = fixture.installer().install();

        assertFalse(status.installedThisCall());
        assertTrue(fixture.recorder().calls.isEmpty());
    }

    private record Fixture(SandboxProperties properties, RecordingInitializer recorder,
                           SandboxServiceInstaller installer) {}

    /**
     * @param srtCli null 表示在临时目录造一个真实存在的 cli.js
     * @param nodeExe null 表示在临时目录造一个真实存在的 node.exe
     */
    private Fixture fixture(Path srtCli, Path nodeExe, boolean probeSucceeds, boolean installSucceeds) {
        try {
            Path resolvedSrtCli = srtCli == null
                    ? Files.createFile(Files.createDirectories(temp.resolve("resources")).resolve("cli.js"))
                    : srtCli;
            Path resolvedNode = nodeExe == null ? Files.createFile(temp.resolve("node.exe")) : nodeExe;
            SandboxProperties properties = new SandboxProperties(temp, resolvedNode, resolvedSrtCli,
                    temp.resolve("state"), Duration.ofSeconds(5), List.of(), null);
            RecordingInitializer recorder = new RecordingInitializer(
                    new CommandTimeoutConfig(5, TimeUnit.SECONDS),
                    new LocalWorkspace("sandbox-service-test", temp.toString()), probeSucceeds, installSucceeds);
            return new Fixture(properties, recorder, new SandboxServiceInstaller(properties, (timeout, workspace) -> recorder));
        } catch (IOException e) {
            throw new IllegalStateException("准备测试沙箱资源失败", e);
        }
    }

    /** 假的框架初始化器：只记录被调用了哪些操作，不真的起子进程（真装会弹 UAC）。 */
    private static final class RecordingInitializer extends SandboxInitializer {
        private final boolean probeSucceeds;
        private final boolean installSucceeds;
        final List<String> calls = new ArrayList<>();

        RecordingInitializer(CommandTimeoutConfig timeout, Workspace workspace,
                             boolean probeSucceeds, boolean installSucceeds) {
            super(timeout, workspace);
            this.probeSucceeds = probeSucceeds;
            this.installSucceeds = installSucceeds;
        }

        @Override
        public void init(Path srtCli, Path node) {
            calls.add("init");
            if (!probeSucceeds) {
                throw new IllegalStateException("SRT sandbox probe failed (exit code 1): WFP fence is missing");
            }
        }

        @Override
        public void installWindows(Path srtCli, Path node) {
            calls.add("installWindows");
            if (!installSucceeds) {
                throw new IllegalStateException(
                        "Windows sandbox installation failed (exit code 2): Install cancelled at the UAC prompt");
            }
        }
    }
}
