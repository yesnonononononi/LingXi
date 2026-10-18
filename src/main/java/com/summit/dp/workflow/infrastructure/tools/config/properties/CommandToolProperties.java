package com.summit.dp.workflow.infrastructure.tools.config.properties;

import com.summit.dp.shared.exception.ClientException;
import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

/** 后台进程独立计时，避免继承前台工具调用的短时限。 */
@ConfigurationProperties(prefix = "lingxi.tools.command")
public class CommandToolProperties {
    private Duration backgroundTimeout = Duration.ofMinutes(30);

    public Duration getBackgroundTimeout() {
        return backgroundTimeout;
    }

    public void setBackgroundTimeout(Duration backgroundTimeout) {
        throwIf(backgroundTimeout == null || backgroundTimeout.compareTo(Duration.ofSeconds(1)) < 0,
                "后台任务超时时长不能小于 1 秒");
        this.backgroundTimeout = backgroundTimeout;
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
