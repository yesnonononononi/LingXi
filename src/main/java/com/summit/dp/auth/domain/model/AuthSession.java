package com.summit.dp.auth.domain.model;

import com.summit.ddd.domain.model.AggregateRoot;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.EqualsAndHashCode;

import java.io.Serializable;
import java.time.Instant;

@EqualsAndHashCode(callSuper = true)
@Data
@AllArgsConstructor
public class AuthSession extends AggregateRoot implements Serializable {
    private String uname;
    private Long userId;
    private Instant expireTime;
    private String token;

}
