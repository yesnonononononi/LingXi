package com.summit.dp.mcp.infrastructure;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.core.CoreConstants;
import org.springframework.boot.logging.logback.WhitespaceThrowableProxyConverter;

/** 第三方 MCP 重连会反复打印堆栈，在输出端统一只保留异常消息。 */
public class McpExceptionConverter extends WhitespaceThrowableProxyConverter {

    @Override
    public String convert(ILoggingEvent event) {
        String loggerName = event.getLoggerName();
        if (loggerName != null && (loggerName.startsWith("dev.langchain4j.mcp.")
                || loggerName.startsWith("com.summit.adapter.langchain4j.mcp.")
                || loggerName.startsWith("com.summit.dp.mcp."))) {
            IThrowableProxy failure = event.getThrowableProxy();
            return failure == null ? "" : "error=" + failure.getMessage() + CoreConstants.LINE_SEPARATOR;
        }
        return super.convert(event);
    }
}
