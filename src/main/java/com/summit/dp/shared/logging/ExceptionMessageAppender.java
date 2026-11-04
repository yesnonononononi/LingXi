package com.summit.dp.shared.logging;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.LoggingEvent;
import ch.qos.logback.core.Appender;
import ch.qos.logback.core.AppenderBase;
import ch.qos.logback.core.spi.AppenderAttachable;
import ch.qos.logback.core.spi.AppenderAttachableImpl;

import java.util.Iterator;

/** 由日志配置选择适用范围，复用已有输出端，避免重复打开同一日志文件。 */
public class ExceptionMessageAppender extends AppenderBase<ILoggingEvent> implements AppenderAttachable<ILoggingEvent> {

    /** cause 链最多展开的层数：够定位根因，又不至于把整棵异常树写进一行日志。 */
    private static final int MAX_CAUSE_DEPTH = 4;
    /** 单条错误摘要的字符上限，防止深层链或服务端长消息把日志行撑爆。 */
    private static final int MAX_ERROR_LENGTH = 500;

    private final AppenderAttachableImpl<ILoggingEvent> delegates = new AppenderAttachableImpl<>();

    @Override
    protected void append(ILoggingEvent event) {
        IThrowableProxy failure = event.getThrowableProxy();
        if (failure == null) {
            delegates.appendLoopOnAppenders(event);
            return;
        }

        // 原始事件可能还有其他消费者，只改写发往当前输出端的副本。
        LoggingEvent message = new LoggingEvent();
        message.setLoggerName(event.getLoggerName());
        message.setLoggerContextRemoteView(event.getLoggerContextVO());
        message.setLevel(event.getLevel());
        message.setThreadName(event.getThreadName());
        message.setInstant(event.getInstant());
        message.setSequenceNumber(event.getSequenceNumber());
        message.setMDCPropertyMap(event.getMDCPropertyMap());
        message.setKeyValuePairs(event.getKeyValuePairs());
        if (event.getMarkerList() != null) event.getMarkerList().forEach(message::addMarker);
        if (event.hasCallerData()) message.setCallerData(event.getCallerData());
        message.setMessage(event.getFormattedMessage() + ", error=" + describeFailure(failure));
        delegates.appendLoopOnAppenders(message);
    }

    /**
     * 渲染「外层消息 + cause 链」。
     *
     * <p>只写外层 message 时，一句「Client failed to initialize」会把超时、TLS、协议版本不匹配
     * 这些根因全部吞掉，多个 server 的失败在日志里长得一模一样。这里保留外层 message 原样打头，
     * 再按「类名: 消息」补上 cause 链，深度与长度都有上限。</p>
     */
    private String describeFailure(IThrowableProxy failure) {
        StringBuilder text = new StringBuilder();
        IThrowableProxy current = failure;
        int depth = 0;
        while (current != null && depth < MAX_CAUSE_DEPTH) {
            if (depth == 0) {
                // 外层沿用原格式（只写消息）；没有消息时退回类名，避免出现 error=null。
                text.append(current.getMessage() == null ? current.getClassName() : current.getMessage());
            } else {
                text.append(" <- ").append(current.getClassName());
                if (current.getMessage() != null) {
                    text.append(": ").append(current.getMessage());
                }
            }
            current = current.getCause();
            depth++;
        }
        if (current != null) text.append(" <- ...");
        return truncate(text.toString());
    }

    private String truncate(String text) {
        if (text.length() <= MAX_ERROR_LENGTH) return text;
        return text.substring(0, MAX_ERROR_LENGTH) + "...";
    }

    @Override
    public void addAppender(Appender<ILoggingEvent> appender) {
        delegates.addAppender(appender);
    }

    @Override
    public Iterator<Appender<ILoggingEvent>> iteratorForAppenders() {
        return delegates.iteratorForAppenders();
    }

    @Override
    public Appender<ILoggingEvent> getAppender(String name) {
        return delegates.getAppender(name);
    }

    @Override
    public boolean isAttached(Appender<ILoggingEvent> appender) {
        return delegates.isAttached(appender);
    }

    @Override
    public void detachAndStopAllAppenders() {
        delegates.detachAndStopAllAppenders();
    }

    @Override
    public boolean detachAppender(Appender<ILoggingEvent> appender) {
        return delegates.detachAppender(appender);
    }

    @Override
    public boolean detachAppender(String name) {
        return delegates.detachAppender(name);
    }
}
