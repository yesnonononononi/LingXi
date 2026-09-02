package com.summit.dp.service.domain.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;

@Schema(description = "用户登录请求参数")
@Data
@AllArgsConstructor
@NoArgsConstructor
@Builder
public class LoginDTO implements Serializable {

    @Schema(description = "手机号码", example = "18573757527", requiredMode = Schema.RequiredMode.REQUIRED)
    private String phoneNumber;

    @Schema(description = "账号密码", example = "password12345", requiredMode = Schema.RequiredMode.REQUIRED)
    private String passWord;
}
