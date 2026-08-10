package com.summit.dp.controller;

import com.summit.dp.service.auth.AuthService;
import com.summit.dp.service.domain.dto.LoginDTO;
import com.summit.dp.service.domain.dto.RegisterDTO;
import com.summit.dp.service.domain.vo.AuthVO;
import com.summit.dp.shared.utils.Result;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "认证服务模块", description = "提供用户登录、注册、登出、密码修改及验证码接口")
@RestController
@RequiredArgsConstructor
@RequestMapping("/auth")
public class AuthController {

    private final AuthService authService;

    @Operation(summary = "用户账号登录", description = "校验手机号和密码，成功后签发并发放 JWT Token")
    @PostMapping("/login")
    public Result<AuthVO> login(@RequestBody LoginDTO dto) {
        return authService.login(dto);
    }

    @Operation(summary = "用户账号注册", description = "校验手机号格式、6位验证码及密码规则并创建账号")
    @PostMapping("/register")
    public Result<Void> register(@RequestBody RegisterDTO dto) {
        return authService.register(dto);
    }

    @Operation(summary = "用户注销/登出", description = "将当前请求头中携带的 Token 加入 Redis/Caffeine 黑名单并作废")
    @PostMapping("/logout")
    public Result<Void> logout() {
        return authService.logout();
    }

    @Operation(summary = "已登录用户修改密码", description = "验证旧密码后更新当前登录账号的密码")
    @PostMapping("/reset-pass")
    public Result<Void> resetPass(
            @Parameter(description = "新密码(至少10位)") @RequestParam String newP,
            @Parameter(description = "原旧密码") @RequestParam String oldP) {
        return authService.resetPass(oldP, newP);
    }

    @Operation(summary = "发送短信验证码", description = "向指定手机号发送6位验证码")
    @PostMapping("/sms")
    public Result<Void> sms(
            @Parameter(description = "手机号码") @RequestParam String phone,
            @Parameter(description = "时间戳") @RequestParam String timestamp) {
        return authService.sms(phone, timestamp);
    }

    @Operation(summary = "通过短信验证码重置密码", description = "忘记密码时，通过6位短信验证码直接重置密码")
    @PostMapping("/forget-pass")
    public Result<Void> forget(
            @Parameter(description = "6位短信验证码") @RequestParam Integer sms,
            @Parameter(description = "新密码") @RequestParam String np,
            @Parameter(description = "手机号码") @RequestParam String phone){
        return authService.resetPassByPSms(sms, np, phone);
    }
}
