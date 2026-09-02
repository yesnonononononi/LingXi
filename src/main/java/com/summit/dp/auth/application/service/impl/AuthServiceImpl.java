package com.summit.dp.auth.application.service.impl;

import cn.hutool.core.util.PhoneUtil;
import cn.hutool.core.util.StrUtil;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.auth.application.service.AuthCacheProvider;
import com.summit.dp.auth.application.service.AuthService;
import com.summit.dp.auth.domain.exception.UserNoExistException;
import com.summit.dp.auth.domain.model.User;
import com.summit.dp.auth.domain.repo.UserRepository;
import com.summit.dp.service.domain.dto.LoginDTO;
import com.summit.dp.service.domain.dto.RegisterDTO;
import com.summit.dp.auth.domain.model.AuthSession;
import com.summit.dp.service.domain.vo.AuthVO;
import com.summit.dp.shared.utils.JwtUtils;
import com.summit.dp.shared.utils.UserContext;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;


@Service
@Slf4j
@RequiredArgsConstructor
public class AuthServiceImpl implements AuthService {
    private final AuthCacheProvider cacheProvider;
    private final UserRepository userRepository;

    @Override
    @Transactional(rollbackFor = Exception.class)
    public Result<AuthVO> login(LoginDTO dto) {
        String phoneNumber = dto.getPhoneNumber();
        String passWord = dto.getPassWord();
        if(StrUtil.isBlank(passWord))return Result.error("密码不能为空");
        if(!PhoneUtil.isMobile(phoneNumber))return Result.error("请输入正确的手机号码");
        log.info("【认证模块】用户登录, 账号: {}", phoneNumber);

        // 1.1 查询用户
        User user = userRepository.findByPhone(phoneNumber).orElseThrow(UserNoExistException::new);

        // 1.2 核验密码
        if (!user.matchPassword(passWord)) {
            return Result.error("密码错误");
        }

        // 1.3 签发 Token
        String token = JwtUtils.generateToken(user.getId().mixId(), user.getMaskedPhone());

        // TODO 更新用户 IP 地理归属地信息
        AuthVO loginVO = new AuthVO(token);

        return Result.success(loginVO);
    }

    @Override
    @Transactional(rollbackFor = Exception.class)
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
            // 3. 密码加密存库
            User user = new User(null, phoneNumber, password, null, null, null, null, null, Instant.now(), Instant.now());

            user.encrypt();
            userRepository.save(user);

        } catch (DuplicateKeyException e) {
            return Result.error("用户已存在,请登录");
        }

        return Result.success();
    }

    @Override
    public Result<Void> logout() {

        AuthSession authSession = UserContext.get();

        Long userId = authSession.getUserId();
        log.info("【认证模块】用户登出, 用户ID: {}", userId);

        Duration duration = Duration.between(Instant.now(), authSession.getExpireTime());

        if (duration.getSeconds() > 0) {
            cacheProvider.put(authSession.getToken(),duration);
        }

        return Result.success();
    }

    @Override
    public Result<Void> resetPass(String oldPass, String newPass) {
        //1, 验证密码
        if (StrUtil.isBlank(newPass) || newPass.length() < 10) return Result.error("请输入正确的密码格式");

        //1.1,查询用户
        Long userId = UserContext.get().getUserId();
        User user = userRepository.findById(userId).orElseThrow(UserNoExistException::new);

        //1.2 比对
        if (!user.matchPassword(oldPass)) {
            return Result.error("密码不正确");
        }

        //2, 保存新密码
        user.updatePassword(newPass);
        userRepository.updateById(user);

        return Result.success();
    }

    @Override
    public Result<Void> sms(String phone, String timestamp) {
        return null;
    }

    @Override
    public Result<Void> resetPassByPSms(Integer sms, String newPass, String phone) {
        if(sms+"".length() != 6)return Result.error("验证码长度需要为6位");
        if(!PhoneUtil.isMobile(phone))return Result.error("手机号格式错误");

        //1,获取用户信息
        User user = userRepository.findByPhone(phone).orElseThrow(UserNoExistException::new);

        //2, 比对验证码
        if (!checkSmsCode(sms))  return Result.error("验证码错误");

        //3, 修改密码
        user.updatePassword(newPass);

        //4,保存
        userRepository.updateById(user);

        return Result.success();
    }

    private boolean checkSmsCode(int smsCode){
        return true;
     }

}
