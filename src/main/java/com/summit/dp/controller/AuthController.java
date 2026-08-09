package com.summit.dp.controller;

import com.summit.dp.service.auth.AuthService;
import com.summit.dp.service.domain.dto.LoginDTO;
import com.summit.dp.service.domain.dto.RegisterDTO;
import com.summit.dp.service.domain.vo.AuthVO;
import com.summit.dp.shared.utils.Result;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/auth-user")
public class AuthController {

    private final AuthService authService;

    @PostMapping("/login")
    public Result<AuthVO> login(LoginDTO dto) {
        return authService.login(dto);
    }

    @PostMapping("/register")
    public Result<Void> register(RegisterDTO dto) {
        return authService.register(dto);
    }

    @PostMapping("/logout")
    public Result<Void> logout(@RequestHeader("Authorization") String token) {
        return authService.logout(token);
    }

    @PostMapping("/reset-pass")
    public Result<Void> resetPass(String newPass) {
        return authService.resetPass(newPass);
    }

    @PostMapping("/sms")
    public Result<Void> sms(String phone, String timestamp) {
        return authService.sms(phone, timestamp);
    }
}
