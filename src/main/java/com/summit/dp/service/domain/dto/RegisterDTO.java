package com.summit.dp.service.domain.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Schema(description = "用户注册请求参数")
@Data
@AllArgsConstructor
@NoArgsConstructor
@Builder
public class RegisterDTO {

    @Schema(description = "手机号码", example = "18573757527", requiredMode = Schema.RequiredMode.REQUIRED)
    private String phoneNumber;

    @Schema(description = "账号密码(至少10位)", example = "password12345", requiredMode = Schema.RequiredMode.REQUIRED)
    private String password;

    @Schema(description = "6位短信验证码", example = "123456", requiredMode = Schema.RequiredMode.REQUIRED)
    private Integer smsCode;
}
