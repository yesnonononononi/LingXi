package com.summit.dp.workspace.application.service;

import com.summit.core.runtime.workspace.OsType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workspace.application.vo.SandboxServiceStatus;
import com.summit.dp.workspace.infrastructure.config.SandboxProperties;
import com.summit.runtime.workspace.LocalWorkspace;
import com.summit.sandbox.CommandTimeoutConfig;
import com.summit.sandbox.SandboxInitializer;
import lombok.extern.slf4j.Slf4j;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Objects;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 沙箱服务的检测与安装（功能类）。
 *
 * <p><b>为什么需要它</b>：Windows 上 SRT 要先跑一次 {@code srt windows-install} 注册系统组件，
 * 否则每次切到沙箱时的就绪探测都必然失败。而框架的 {@code SandboxWorkspaceProvider} 只探测、
 * 从不安装（{@code SandboxInitializer#installWindows} 的注释写明「由应用决定何时提供这个操作」），
 * 所以「装不装、什么时候装、装不上怎么跟用户说」都归业务侧。</p>
 *
 * <p><b>安装会弹 UAC</b>，因此进程内自动尝试一次为限：第一次探测不过才装；装不上就改成提示用户
 * 到设置页手动装，不会每轮请求都弹一次。</p>
 */
@Slf4j
public class SandboxServiceInstaller {

    /** 构造 {@link SandboxInitializer} 的口子：默认桥接框架，测试用它避开真实子进程。 */
    @FunctionalInterface
    public interface InitializerFactory {
        SandboxInitializer create(CommandTimeoutConfig timeout, Workspace workspace);
    }

    /** 宿主 OS 从 Workspace 的运行时环境读，与框架内部口径一致，不另写一份 os.name 解析。 */
    private static final String WORKSPACE_ID = "sandbox-service";

    private final SandboxProperties properties;
    private final InitializerFactory initializerFactory;

    /** 本进程内已确认可用：之后只是一次布尔判断，不再重复探测。 */
    private final AtomicBoolean ensured = new AtomicBoolean(false);

    /** 本进程内已自动装过一次：装不上不再自动重试（UAC 不能每轮弹），改为提示手动安装。 */
    private final AtomicBoolean installAttempted = new AtomicBoolean(false);

    public SandboxServiceInstaller(SandboxProperties properties) {
        this(properties, SandboxInitializer::new);
    }

    public SandboxServiceInstaller(SandboxProperties properties, InitializerFactory initializerFactory) {
        this.properties = Objects.requireNonNull(properties, "沙箱配置不能为空");
        this.initializerFactory = Objects.requireNonNull(initializerFactory, "初始化器工厂不能为空");
    }

    /** 只检测，不跑任何命令：供界面判断要不要显示「安装」入口。 */
    public SandboxServiceStatus inspect() {
        String missing = missingPackageMessage();
        if (missing != null) {
            return new SandboxServiceStatus(isWindows(), false, false, missing);
        }
        if (!isWindows()) {
            return new SandboxServiceStatus(false, true, false, "当前平台不需要安装沙箱服务");
        }
        return new SandboxServiceStatus(true, true, false, "沙箱资源已就位；如需重新注册 Windows 沙箱组件，可执行安装");
    }

    /** 显式安装（设置页按钮）：检测 srt 包，Windows 上执行安装并随后探测。 */
    public SandboxServiceStatus install() {
        requirePackage();
        if (!isWindows()) {
            ensured.set(true);
            return new SandboxServiceStatus(false, true, false, "当前平台不需要安装沙箱服务");
        }
        // 先记账再执行：安装会抛异常，把置位写在后面等于「装失败 = 没装过」，下一次请求又会弹一遍 UAC。
        installAttempted.set(true);
        installWindows();
        ensured.set(true);
        return new SandboxServiceStatus(true, true, true, "沙箱服务安装完成");
    }

    /**
     * 启动沙箱模式前的就绪检查：srt 包必须在位；Windows 上已就绪就直接放行，
     * 探测不过才安装一次（这一步会弹 UAC）。
     */
    public SandboxServiceStatus ensureReady() {
        requirePackage();
        if (!isWindows()) {
            ensured.set(true);
            return new SandboxServiceStatus(false, true, false, "当前平台不需要安装沙箱服务");
        }
        if (ensured.get()) {
            return new SandboxServiceStatus(true, true, false, "沙箱服务已就绪");
        }
        if (probe()) {
            ensured.set(true);
            return new SandboxServiceStatus(true, true, false, "沙箱服务已就绪");
        }
        // 探测不过，多半是 Windows 组件没注册：装一次再探测；装不上就不再自动重试。
        //
        // 必须是 CAS 占坑，不能「先 get 再 set」：团队模式下根执行与各子代理的执行会并发解析工作区
        // （框架每次执行开始都调 resolve），先读后写会让两个线程同时判定「没装过」，各弹一次 UAC。
        // 先占坑再执行，顺带把「安装失败」也记成已尝试 —— 否则失败会被当成没装过，每轮请求重弹。
        if (!installAttempted.compareAndSet(false, true)) {
            throw new ClientException("沙箱服务不可用，请在设置中执行「安装沙箱服务」后重试");
        }
        installWindows();
        ensured.set(true);
        return new SandboxServiceStatus(true, true, true, "已完成 Windows 沙箱组件安装");
    }

    /** srt 包检测：缺哪个文件就说哪个，别让用户对着框架的英文异常猜。 */
    private String missingPackageMessage() {
        Path srtCli = properties.srtCli();
        if (!isRegularFile(srtCli)) {
            return "沙箱资源缺失：srt-cli 不存在（" + srtCli + "），请检查安装目录是否完整";
        }
        Path nodeExe = properties.nodeExe();
        if (!isRegularFile(nodeExe)) {
            return "沙箱资源缺失：node-exe 不存在（" + nodeExe + "），请检查安装目录是否完整";
        }
        return null;
    }

    private void requirePackage() {
        String missing = missingPackageMessage();
        if (missing != null) {
            throw new ClientException(missing);
        }
    }

    /** 就绪探测：框架内部会跑 node --version / srt --version / 一条真实沙箱命令。 */
    private boolean probe() {
        try {
            initializer().init(properties.srtCli(), properties.nodeExe());
            return true;
        } catch (IOException | IllegalStateException failure) {
            log.info("沙箱就绪探测未通过，将尝试安装: {}", failure.getMessage());
            return false;
        }
    }

    private void installWindows() {
        try {
            initializer().installWindows(properties.srtCli(), properties.nodeExe());
        } catch (IOException | IllegalStateException failure) {
            // 用户取消 UAC 也走这里：把框架给的诊断原样带上，否则用户无从判断是取消还是真失败。
            throw new ClientException("沙箱服务安装失败：" + failure.getMessage());
        }
    }

    /**
     * 框架的 {@code SandboxInitializer} 需要 Workspace 只是为了取宿主 OS，
     * 因此这里给的 workDir 不参与安装流程，取用户主目录以免依赖可能未配置的沙箱路径。
     */
    private Workspace localWorkspace() {
        return new LocalWorkspace(WORKSPACE_ID, System.getProperty("user.home"));
    }

    private boolean isWindows() {
        return localWorkspace().runtimeEnvironment().osType() == OsType.WINDOWS;
    }

    private SandboxInitializer initializer() {
        CommandTimeoutConfig timeout = new CommandTimeoutConfig(
                properties.timeout().toMillis(), TimeUnit.MILLISECONDS);
        return initializerFactory.create(timeout, localWorkspace());
    }

    private static boolean isRegularFile(Path path) {
        return path != null && Files.isRegularFile(path);
    }
}
