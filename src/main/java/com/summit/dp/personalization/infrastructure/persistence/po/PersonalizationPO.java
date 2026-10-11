package com.summit.dp.personalization.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.NoArgsConstructor;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;

/** 保留独立时间字段，JSON 重载后仍能沿用创建时间。 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("personalization")
public class PersonalizationPO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String replyStyle;
    private String title;
    private String commonAgentName;
    private String customInstruction;
    private Instant createAt;
    private Instant updateAt;
}
