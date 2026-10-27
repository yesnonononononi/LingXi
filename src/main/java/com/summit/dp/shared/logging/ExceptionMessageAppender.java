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
        message.setMessage(event.getFormattedMessage() + ", error=" + failure.getMessage());
        delegates.appendLoopOnAppenders(message);
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
