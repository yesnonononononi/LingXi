package com.summit.dp.provider.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/** 提供商配置持久化对象；运行期真源是 providers.json，本表只承担建库与历史导入。 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("provider_config")
public class ProviderConfigPO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String name;
    private String icon;
    private String baseUrl;
    private String apiKey;
    private Integer sortOrder;
    private Instant createTime;
    private Instant updateTime;
}
