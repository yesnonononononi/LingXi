package com.summit.dp.shared.vo;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import lombok.Builder;
import lombok.Data;

import java.util.List;

/** 会话树：根会话 id + 平铺的会话列表（含根会话自身）。 */
@Data
@Builder
public class SessionTreeVO {
    /** 真正的根会话 id：{@code id} 等于它的那条即根会话 */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long rootSessionId;
    private List<SessionVO> sessions;
}
