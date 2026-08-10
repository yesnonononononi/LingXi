package com.summit.dp.service.domain.model.auth;

import lombok.Builder;
import lombok.Data;

import java.io.Serializable;
import java.time.Instant;

@Data
@Builder
public class AuthSession implements Serializable {
    private String uname;
    private Long userId;
    private Instant expireTime;
    private String token;

}
