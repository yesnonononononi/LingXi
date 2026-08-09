package com.summit.dp.persistence.mapper.user;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.service.domain.model.User;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface UserMapper extends BaseMapper<User> {
}
