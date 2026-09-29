package com.summit.dp.shared.vo;

import lombok.Builder;
import lombok.Data;

import java.util.List;

/** 会话消息游标分页结果。 */
@Data
@Builder
public class SessionMessagePageVO {
    private List<SessionMessageVO> records;
    private int toolCallCount;
    /** 下一页游标，为空表示已到末页 */
    private String nextCursor;
    private boolean hasMore;
}
