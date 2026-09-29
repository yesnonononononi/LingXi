package com.summit.dp.session.domain.model;



import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

@Builder
@Getter
public class SessionMessage {
    private final Long id;
    private final Long sessionId;
    private final SessionMessageType type;
    private String text;
    private final Instant createTime;

}
