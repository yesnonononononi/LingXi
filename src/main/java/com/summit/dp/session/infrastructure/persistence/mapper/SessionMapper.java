package com.summit.dp.session.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface SessionMapper extends BaseMapper<SessionPO> {
}
