package com.summit.dp.personalization.application.vo;

import lombok.Data;

/**
 * Personalization 视图对象（生成骨架）
 * <p>骨架仅承载聚合标识，敏感数据（如密码哈希）不进视图层，业务字段按需在生成后补充。</p>
 */
@Data
public class PersonalizationVO {
    private Long id;
}
