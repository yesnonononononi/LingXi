package com.summit.dp.service.auth;

import com.summit.dp.service.domain.dto.LoginDTO;
import com.summit.dp.service.domain.dto.RegisterDTO;
import com.summit.dp.service.domain.vo.AuthVO;
import com.summit.dp.shared.utils.Result;

public interface AuthService {
    Result<AuthVO> login(LoginDTO dto);
    Result<Void> register(RegisterDTO dto);


    Result<Void> logout(String token);

    Result<Void> resetPass(String newPass);
    Result<Void> sms(String phone,String timestamp);
}
