package com.summit.dp.model.Infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Builder;
import lombok.Getter;

@Getter
@Builder
@TableName("model_config")
public class ModelConfigPO {
    @TableId(type= IdType.AUTO)
    private Long id;
    private String modelName;
    private String baseUrl;
    private String apiKey;
}
