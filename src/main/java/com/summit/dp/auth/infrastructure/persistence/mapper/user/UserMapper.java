package com.summit.dp.auth.infrastructure.persistence.mapper.user;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.auth.infrastructure.persistence.po.UserPO;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface UserMapper extends BaseMapper<UserPO> {
}
