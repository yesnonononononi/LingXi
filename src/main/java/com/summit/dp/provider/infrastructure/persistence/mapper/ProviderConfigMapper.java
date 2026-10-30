package com.summit.dp.provider.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.provider.infrastructure.persistence.po.ProviderConfigPO;
import org.apache.ibatis.annotations.Mapper;

/** 仅用于「首次建库时把 providers.json 导入库」，运行期读写都走 JSON 文件。 */
@Mapper
public interface ProviderConfigMapper extends BaseMapper<ProviderConfigPO> {
}
