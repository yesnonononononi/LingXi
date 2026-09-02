package com.summit.dp.auth.infrastructure.persistence.repo;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.auth.domain.model.User;
import com.summit.dp.auth.domain.model.UserId;
import com.summit.dp.auth.domain.repo.UserRepository;
import com.summit.dp.auth.infrastructure.persistence.mapper.user.UserMapper;
import com.summit.dp.auth.infrastructure.persistence.po.UserPO;
import lombok.RequiredArgsConstructor;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
@RequiredArgsConstructor
public class UserRepositoryImpl extends AbstractRepository<User, UserPO,Long> implements UserRepository {
    private final UserMapper userMapper;

    @Override
    protected UserPO toPO(User entity) {
        return UserPO.builder()
                .id(entity.getId().getValue())
                .password(entity.getPassword())
                .phone(entity.getPhone())
                .nick(entity.getNick())
                .avatar(entity.getAvatar())
                .accountId(entity.getAccountId())
                .ip(entity.getIp())
                .ipLocation(entity.getIpLocation())
                .createTime(entity.getCreateTime())
                .updateTime(entity.getUpdateTime())
                .build();
    }

    @Override
    protected User toModel(UserPO po) {
        return new User(
                UserId.of(po.getId()),
                po.getPassword(),
                po.getPhone(),
                po.getNick(),
                po.getAvatar(),
                po.getAccountId(),
                po.getIp(),
                po.getIpLocation(),
                po.getCreateTime(),
                po.getUpdateTime()
        );
    }

    @Override
    protected @NotNull BaseMapper<UserPO> mapper() {
        return userMapper;
    }

    @Override
    public Optional<User> findByPhone(String phoneNumber) {
        return findBy(phoneNumber,UserPO::getPhone);
    }
}
