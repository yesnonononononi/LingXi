package com.summit.dp.session.application.service;

import com.summit.dp.shared.vo.SessionVO;

/** 提交后才能广播，避免客户端看到已回滚的已读状态。 */
public record SessionStateChanged(SessionVO session) { }
