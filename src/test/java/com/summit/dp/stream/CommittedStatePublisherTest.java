package com.summit.dp.stream;

import com.summit.dp.shared.event.*;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import java.util.stream.Stream;
import static org.mockito.Mockito.*;

class CommittedStatePublisherTest {
    @AfterEach void clear() {
        if (TransactionSynchronizationManager.isSynchronizationActive()) TransactionSynchronizationManager.clearSynchronization();
    }
    @SuppressWarnings("unchecked")
    @Test void observersRunOnlyAfterCommitAndFailureDoesNotSkipNextModule() {
        ObjectProvider<CommittedStateObserver> observers = mock(ObjectProvider.class);
        CommittedStateObserver broken = mock(CommittedStateObserver.class);
        CommittedStateObserver good = mock(CommittedStateObserver.class);
        CommittedStateChange change = CommittedStateChange.entity(CommittedStateChange.Kind.TOOL, 1L, "call");
        when(observers.orderedStream()).thenAnswer(call -> Stream.of(broken, good));
        doThrow(new IllegalStateException("查询失败")).when(broken).changed(change);
        CommittedStatePublisher publisher = new CommittedStatePublisher(observers);
        TransactionSynchronizationManager.initSynchronization(); publisher.publish(change);
        verifyNoInteractions(good);
        TransactionSynchronizationManager.getSynchronizations().forEach(TransactionSynchronization::afterCommit);
        verify(good).changed(change);
    }
    @SuppressWarnings("unchecked")
    @Test void rollbackNeverNotifies() {
        ObjectProvider<CommittedStateObserver> observers = mock(ObjectProvider.class);
        TransactionSynchronizationManager.initSynchronization();
        new CommittedStatePublisher(observers).publish(CommittedStateChange.entity(CommittedStateChange.Kind.TOOL, 1L, "call"));
        TransactionSynchronizationManager.getSynchronizations().forEach(sync -> sync.afterCompletion(TransactionSynchronization.STATUS_ROLLED_BACK));
        verifyNoInteractions(observers);
    }
}
