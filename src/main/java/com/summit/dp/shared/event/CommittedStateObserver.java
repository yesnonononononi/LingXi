package com.summit.dp.shared.event;

/** 各模块独立订阅，某个观察者失败不能阻断其他模块。 */
public interface CommittedStateObserver {
    void changed(CommittedStateChange change);
}
