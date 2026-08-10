package com.summit.dp.service.domain.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Schema(description = "认证响应结果")
@Data
@AllArgsConstructor
@NoArgsConstructor
public class AuthVO {

    @Schema(description = "JWT 认证令牌 Token", example = "eyJhbGciOiJIUzI1NiJ9...")
    private String token;
}
