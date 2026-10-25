package com.summit.dp.execution.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.Instant;

@Data
@TableName("runtime_config_revision")
public class RuntimeConfigRevisionPO {
    @TableId(type = IdType.INPUT)
    private Long id;
    private String kind;
    private Long configId;
    private int revision;
    private String fingerprint;
    private String payload;
    private Instant createdAt;
}
