package com.summit.dp.shared.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.shared.vo.LogLocationVO;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Path;

/**
 * 日志位置接口层。
 *
 * <p><b>为什么由后端报、而不是前端自己拼</b>：日志目录的缺省来自启动参数，而桌面端可能复用一个
 * 已经在跑的实例（IDE 里起的、上次残留的）—— 那种情况下它用的不是本次启动器算出来的目录，
 * 前端照自己的值拼就会指向一个不存在的文件。所以位置的唯一真源是后端进程自己。</p>
 */
@RestController
@RequestMapping("/log")
public class LogController {

    /**
     * 与 {@code logback-spring.xml} 的 {@code springProperty} 同名同缺省值，两处必须一起改。
     * 文件名同理：{@code WARN_ERROR_FILE_NAME} 对应那里的 {@code <file>}。
     */
    private static final String DEFAULT_DIR = "${user.home}/.lingxi/logs";
    private static final String WARN_ERROR_FILE_NAME = "warn-error.log";

    private final Path logDir;

    public LogController(@Value("${lingxi.log.dir:" + DEFAULT_DIR + "}") String logDir) {
        this.logDir = Path.of(logDir);
    }

    /** WARN/ERROR 日志（含堆栈）的落点；供界面点击打开文件预览。 */
    @GetMapping("/location")
    public Result<LogLocationVO> location() {
        return Result.success(LogLocationVO.of(logDir, WARN_ERROR_FILE_NAME));
    }
}
