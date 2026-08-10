package com.summit.dp.shared.utils;

import cn.hutool.core.util.StrUtil;
import com.summit.dp.service.domain.model.auth.AuthSession;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.sql.Date;
import java.time.Instant;
import java.time.temporal.ChronoUnit;

public class JwtUtils {

    private static final String DEFAULT_SECRET = "lingxi-secret-key-lingxi-secret-key-32bytes";
    private static final int DEFAULT_TTL_DAYS = 7;

    public static String generateToken(Long userId, String uname) {
        return generateToken(userId, uname, DEFAULT_SECRET, DEFAULT_TTL_DAYS);
    }

    public static String generateToken(Long userId, String uname, String secretKey, int ttlDays) {
        if(StrUtil.isBlank(uname) || userId == null)throw new RuntimeException("需要用户id和用户名作为载体");
        return Jwts.builder()
                .subject(userId.toString())
                .claim("uname", uname)
                .expiration(Date.from(Instant.now().plus(ttlDays, ChronoUnit.DAYS)))
                .signWith(parseKey(secretKey))
                .compact();
    }

    public static AuthSession resolveToken(String token) {
        return resolveToken(token, DEFAULT_SECRET);
    }

    public static AuthSession resolveToken(String token, String secretKey) {
        Claims body = Jwts.parser()
                .verifyWith(parseKey(secretKey))
                .build()
                .parseSignedClaims(token)
                .getPayload();

        return AuthSession.builder()
                .uname(body.get("uname").toString())
                .expireTime(body.getExpiration().toInstant())
                .userId(Long.valueOf(body.getSubject()))
                .build();
    }

    private static SecretKey parseKey(String key) {
        return Keys.hmacShaKeyFor(key.getBytes(StandardCharsets.UTF_8));
    }

}
