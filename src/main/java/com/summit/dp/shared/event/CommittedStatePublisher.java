package com.summit.dp.shared.event;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** 观察者失败不改变已经提交的业务结果，重连时仍会校准数据库。 */
@Component
@RequiredArgsConstructor
@Slf4j
public class CommittedStatePublisher {
    private final ObjectProvider<CommittedStateObserver> observers;
    public void publish(CommittedStateChange change) {
        Runnable notify = () -> {
            observers.orderedStream().forEach(observer -> {
                try { observer.changed(change); }
                catch (RuntimeException error) {
                    log.error("提交后通知失败: kind={}, id={}", change.kind(), change.id(), error);
                }
            });
        };
        if (!TransactionSynchronizationManager.isSynchronizationActive()) notify.run();
        else TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() { notify.run(); }
        });
    }
}
