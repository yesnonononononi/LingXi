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
import java.time.Duration;
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
 * 到设置页手动装，不会每轮请求都弹一次。设置页的显式安装走同一套，但**允许失败后重试**，
 * 只挡并发（{@link #installing}）不挡重试。</p>
 *
 * <p><b>失败文案只有两档，且都不带框架原文</b>：Windows 前置依赖装不上 →「沙箱前置依赖安装失败，
 * 详情见错误日志」；其余初始化类失败 →「沙箱初始化失败，具体原因见日志」。exit code、SRT 原文
 * 与堆栈一律只进日志。</p>
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

    /**
     * 安装预算的下限。
     *
     * <p><b>不能沿用探测的预算</b>：SRT 自己的安装预算是 120s（{@code INSTALL_TIMEOUT_MS}），且安装是
     * <b>自提权 + 模态 UAC</b> —— 用户要时间点确认框。预算一旦小于 120s，框架会在 SRT 还没收工前杀掉
     * 子进程，于是「装成了」被报成「失败」（实测：exit code -1，SRT 原文却是 {@code Installed.}，
     * 事后 {@code provisioned} 已是 true）。取 3 分钟 = SRT 的 120s 再留一倍余量给 UAC 应答。</p>
     */
    private static final Duration INSTALL_BUDGET_FLOOR = Duration.ofMinutes(3);

    private final SandboxProperties properties;
    private final InitializerFactory initializerFactory;

    /** 本进程内已确认可用：之后只是一次布尔判断，不再重复探测。 */
    private final AtomicBoolean ensured = new AtomicBoolean(false);

    /** 本进程内已自动装过一次：装不上不再自动重试（UAC 不能每轮弹），改为提示手动安装。 */
    private final AtomicBoolean installAttempted = new AtomicBoolean(false);

    /**
     * 本进程内正在安装。
     *
     * <p>与 {@link #installAttempted} 的职责不同：那个只保证**自动路径不重复触发**，挡不住
     * 「设置页点了安装」与「某次执行解析工作区」交叉并发 —— 两边都进了安装就会弹两次 UAC。
     * 真正的互斥归这个 CAS，且**只挡并发、不挡重试**（失败后用户再点一次是合法动作）。</p>
     */
    private final AtomicBoolean installing = new AtomicBoolean(false);

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

    /**
     * 显式安装（设置页按钮）：检测 srt 包，Windows 上执行安装并随后探测。
     *
     * <p>与自动路径的区别：**允许失败后重试**（用户可能刚处理完权限问题又点了一次），
     * 所以这里不检查 {@link #installAttempted}，只用 {@link #installing} 挡并发 ——
     * 连点两次按钮不能弹两次 UAC。</p>
     */
    public SandboxServiceStatus install() {
        requirePackage();
        if (!isWindows()) {
            ensured.set(true);
            return new SandboxServiceStatus(false, true, false, "当前平台不需要安装沙箱服务");
        }
        // 先记账再执行：安装会抛异常，把置位写在后面等于「装失败 = 没装过」，下一次请求又会弹一遍 UAC。
        installAttempted.set(true);
        runInstallOnce();
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
        runInstallOnce();
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

    /**
     * 就绪探测：框架内部会跑 node --version / srt --version / 一条真实沙箱命令。
     *
     * <p>失败只记日志、不抛：这时候还没到「安装失败」那一步，下一步是尝试安装。</p>
     */
    private boolean probe() {
        try {
            initializer(properties.timeout()).init(properties.srtCli(), properties.nodeExe());
            return true;
        } catch (IOException | IllegalStateException failure) {
            // 带上 throwable 而不是只取 getMessage()：「为什么探测不过」是判断该不该装、装没装对的第一手证据。
            // 框架抛的消息本身已含 exit code 与 SRT 原文（requireSuccess 拼的），堆栈能进一步指出卡在
            // node --version / srt --version / srt -c whoami 哪一步。
            log.warn("沙箱就绪探测未通过，将尝试安装 Windows 沙箱组件", failure);
            return false;
        }
    }

    /**
     * 安装失败后的复查：安装这件事「被杀掉」和「没装成」是两回事。
     *
     * <p>SRT 的安装是自提权的一次性子进程，框架一旦把预算用尽就会杀进程，但 SRT 往往已经打完收工。
     * 所以失败后必须再探一次：探过了就当安装成功 —— 否则 {@link #installAttempted} 白白烧掉，
     * 用户被指引去「设置页手动安装」，而机器其实已经就绪。</p>
     */
    private boolean installedAfterAll() {
        try {
            initializer(installBudget()).init(properties.srtCli(), properties.nodeExe());
            return true;
        } catch (IOException | IllegalStateException stillFailing) {
            log.info("安装失败后的复查仍未通过，确认为安装失败", stillFailing);
            return false;
        }
    }

    /** 安装预算：取配置值与 {@link #INSTALL_BUDGET_FLOOR} 的较大者，别被探测那档的 60s 卡住。 */
    private Duration installBudget() {
        Duration configured = properties.timeout();
        return configured.compareTo(INSTALL_BUDGET_FLOOR) > 0 ? configured : INSTALL_BUDGET_FLOOR;
    }

    /**
     * 真正执行一次安装，并用 {@link #installing} 把并发挡在外面。
     *
     * <p>放在这里而不是 {@link #installWindows()} 里面，是为了让**安装**这件事整体互斥：
     * 两条路径（自动 / 显式）都会经过它，只有一方能进。</p>
     */
    private void runInstallOnce() {
        if (!installing.compareAndSet(false, true)) {
            throw new ClientException("沙箱服务正在安装中，请稍候");
        }
        try {
            installWindows();
        } finally {
            installing.set(false);
        }
    }

    /**
     * 执行 Windows 组件安装。失败（<b>含用户主动取消 UAC</b>）一律同一条路：
     *
     * <ul>
     *   <li>面向界面只抛一句可读结论，不把英文原文和堆栈甩给用户；</li>
     *   <li>完整诊断（框架拼的 exit code + SRT 原文 + 堆栈）写日志，供排查。</li>
     * </ul>
     *
     * <p><b>用户取消 UAC 不做特例</b>：要区分它和真实失败，看日志里的 exit code
     * （SRT 约定 2 = UAC 取消，其余归 1）即可；而在界面层去猜「是不是用户取消」只能匹配文案，
     * SRT 与框架都明说文案随版本变，所以这里刻意不猜。</p>
     */
    /**
     * 执行 Windows 组件安装。失败（<b>含用户主动取消 UAC</b>）一律同一条路：
     *
     * <ul>
     *   <li>面向界面只抛一句可读结论，不把英文原文和堆栈甩给用户；</li>
     *   <li>完整诊断（框架拼的 exit code + SRT 原文 + 堆栈）写日志，供排查。</li>
     * </ul>
     *
     * <p><b>用户取消 UAC 不做特例</b>：要区分它和真实失败，看日志里的 exit code 即可
     * （SRT 约定 2 = UAC 取消；-1 = 预算内没跑完、被框架杀掉，见 {@link #INSTALL_BUDGET_FLOOR}）。
     * 在界面层去猜「是不是用户取消」只能匹配文案，SRT 与框架都明说文案随版本变，所以这里刻意不猜。</p>
     */
    private void installWindows() {
        try {
            initializer(installBudget()).installWindows(properties.srtCli(), properties.nodeExe());
        } catch (IOException | IllegalStateException failure) {
            // 这条 error 就是「详情见错误日志」所指的东西：格式固定、可 grep「沙箱前置依赖安装失败」定位。
            log.error("沙箱前置依赖安装失败：Windows 沙箱组件安装未成功（srt-cli={}, node-exe={}；"
                    + "exit code 2 = 用户取消 UAC，-1 = 预算内没跑完被框架杀掉）",
                    properties.srtCli(), properties.nodeExe(), failure);
            // 被杀掉 ≠ 没装成：先复查一次，机器已就绪就别把「能用的沙箱」报成失败。
            if (installedAfterAll()) {
                log.warn("沙箱组件安装命令未正常结束，但随后探测通过，按安装成功处理");
                return;
            }
            throw new ClientException("沙箱前置依赖安装失败，详情见错误日志");
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

    private SandboxInitializer initializer(Duration budget) {
        CommandTimeoutConfig timeout = new CommandTimeoutConfig(budget.toMillis(), TimeUnit.MILLISECONDS);
        return initializerFactory.create(timeout, localWorkspace());
    }

    private static boolean isRegularFile(Path path) {
        return path != null && Files.isRegularFile(path);
    }
}
