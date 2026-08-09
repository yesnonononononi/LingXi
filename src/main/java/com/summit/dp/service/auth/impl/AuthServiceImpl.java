package com.summit.dp.service.auth.impl;

import cn.hutool.core.util.PhoneUtil;
import cn.hutool.core.util.StrUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.summit.dp.persistence.mapper.user.UserMapper;
import com.summit.dp.service.auth.AuthService;
import com.summit.dp.service.domain.dto.LoginDTO;
import com.summit.dp.service.domain.dto.RegisterDTO;
import com.summit.dp.service.domain.model.User;
import com.summit.dp.service.domain.model.auth.AuthSession;
import com.summit.dp.service.domain.vo.AuthVO;
import com.summit.dp.shared.utils.JwtUtils;
import com.summit.dp.shared.utils.Result;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoField;
import java.util.concurrent.TimeUnit;


@Service
@Slf4j
public class AuthServiceImpl implements AuthService {
    private final UserMapper userMapper;
    private final RedisTemplate<Object, Object> redisTemplate;

    public AuthServiceImpl(UserMapper userMapper, RedisTemplate<Object, Object> redisTemplate) {
        this.userMapper = userMapper;
        this.redisTemplate = redisTemplate;
    }

    @Override
    public Result<AuthVO> login(LoginDTO dto) {
        String phoneNumber = dto.getPhoneNumber();
        String passWord = dto.getPassWord();
        if(StrUtil.isBlank(passWord))return Result.error("密码不能为空");
        if(!PhoneUtil.isMobile(phoneNumber))return Result.error("请输入正确的手机号码");
        log.info("【认证模块】用户登录, 账号: {}", phoneNumber);

        // 1.1 查询用户
        User user = userMapper.selectOne(new LambdaQueryWrapper<>(User.class).eq(User::getPhone, phoneNumber));
        if (user == null) return Result.error("未找到用户信息");

        // 1.2 核验密码

        if (!user.matchPassword(passWord)) {
            return Result.error("密码错误");
        }

        // 1.3 签发 Token
        String token = JwtUtils.generateToken(user.getId(), user.getMaskedPhone());

        // TODO 更新用户 IP 地理归属地信息
        AuthVO loginVO = new AuthVO(token);

        return Result.success(loginVO);
    }

    @Override
    public Result<Void> register(RegisterDTO dto) {
        String password = dto.getPassword();
        String phoneNumber = dto.getPhoneNumber();
        Integer smsCode = dto.getSmsCode();

        // 1. 基础信息验证
        if (StrUtil.isBlank(password) || password.length() < 10) return Result.error("请输入正确的密码格式");
        if (!PhoneUtil.isMobile(phoneNumber)) return Result.error("请输入正确的手机号格式");
        if (smsCode == null || smsCode.toString().length() != 6) return Result.error("请输入6位验证码");

        // 2. 验证码验证
        if (!checkSmsCode(smsCode)) return Result.error("验证码不正确");

        log.info("【认证模块】用户注册, 账号: {}", phoneNumber);

        try {
            // 3. 密码 BCrypt 加密存库
            String encodedPassword = User.encryptPassword(password);
            userMapper.insert(User.builder().phone(phoneNumber).password(encodedPassword).build().rebuildId());
        } catch (DuplicateKeyException e) {
            return Result.error("用户已存在,请登录");
        }

        return Result.success();
    }

    @Override
    public Result<Void> logout(String token) {
        final String KEY = "auth:token:blackList:";

        AuthSession authSession = JwtUtils.resolveToken(token);

        log.info("【认证模块】用户登出, 用户ID: {}", authSession.getUserId());

        long remainSeconds = Duration.between(Instant.now(), authSession.getExpireTime()).getSeconds();

        if (remainSeconds > 0) {
            redisTemplate.opsForValue().set(KEY + token, "1", remainSeconds, TimeUnit.SECONDS);
        }

        return Result.success();
    }

    @Override
    public Result<Void> resetPass(String newPass) {
        return null;
    }

    @Override
    public Result<Void> sms(String phone, String timestamp) {
        return null;
    }

     private boolean checkSmsCode(int smsCode){
        return true;
     }
}
