package com.summit.dp.auth.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.service.domain.dto.LoginDTO;
import com.summit.dp.service.domain.dto.RegisterDTO;
import com.summit.dp.service.domain.vo.AuthVO;

public interface AuthService  {
    Result<AuthVO> login(LoginDTO dto);

    Result<Void> register(RegisterDTO dto);


    Result<Void> logout();


    Result<Void> resetPass(String oldPass, String newPass);

    Result<Void> sms(String phone, String timestamp);


    Result<Void> resetPassByPSms(Integer sms, String newPass, String phone);
}
