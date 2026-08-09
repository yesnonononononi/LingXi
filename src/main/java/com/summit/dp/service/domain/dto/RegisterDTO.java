package com.summit.dp.service.domain.dto;

import lombok.Builder;
import lombok.Data;
import lombok.Getter;

@Data
@Builder
public class RegisterDTO {
    private String phoneNumber;
    private String password;
    private Integer smsCode;
}
