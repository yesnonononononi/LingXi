package com.summit.dp.model.Infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("model_config")
public class ModelConfigPO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String baseUrl;
    private String apiKey;
    private String modelName;
    private String provider;
    /** 所属提供商预设(provider_config.id)；空=未归属，聚合时归入「未分组」。 */
    private Long providerConfigId;
    private boolean vision;
    private Instant createTime;
    private Instant updateTime;
}
