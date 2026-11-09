package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

/** 已包含在消息分项中的归因明细。 */
@Data
@Builder
@JsonInclude(JsonInclude.Include.NON_NULL)
public class TokenAuditContextAttributionVO {

    /** 记忆正文 token（不含标题与消息分帧）；null 表示未知。 */
    private Integer memoryTokens;
}
