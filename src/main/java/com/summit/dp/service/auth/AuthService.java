package com.summit.dp.service.auth;

import com.baomidou.mybatisplus.extension.service.IService;
import com.summit.dp.service.domain.dto.LoginDTO;
import com.summit.dp.service.domain.dto.RegisterDTO;
import com.summit.dp.service.domain.model.User;
import com.summit.dp.service.domain.vo.AuthVO;
import com.summit.dp.shared.utils.Result;

public interface AuthService extends IService<User> {
    Result<AuthVO> login(LoginDTO dto);

    Result<Void> register(RegisterDTO dto);


    Result<Void> logout();


    Result<Void> resetPass(String oldPass, String newPass);

    Result<Void> sms(String phone, String timestamp);


    Result<Void> resetPassByPSms(Integer sms, String newPass, String phone);
}
