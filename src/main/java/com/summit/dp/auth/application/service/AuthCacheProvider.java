package com.summit.dp.auth.application.service;

import cn.hutool.core.util.StrUtil;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.summit.dp.shared.utils.UserContext;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.AbstractMap;
import java.util.Map;

import java.util.concurrent.TimeUnit;
@Component
@RequiredArgsConstructor
@Slf4j
public class AuthCacheProvider {
    final String KEY = "auth:token:blackList:";

    private final RedisTemplate<Object, Object> redisTemplate;
    @Value("${lingxi.auth.token.ttl:7}")
    private Long ttl;
    
    private final Cache<String, Long> localBlackList = Caffeine.newBuilder()
            .maximumSize(10000)
            .expireAfterWrite(7, TimeUnit.DAYS)
            .build();

    public void put(String token, Duration duration){
        String cleanToken = cleanToken(token);
        try {
            String key = KEY + cleanToken;
            redisTemplate.opsForValue().setBit(key, 1, true);
            redisTemplate.expire(key, duration);
        } catch (Exception e) {
            log.error("【黑名单-新增失败】:降级本地缓存{}", cleanToken);
            this.put(new AbstractMap.SimpleEntry<>(cleanToken, UserContext.get().getUserId()));
        }
    }

    public boolean isExist(String token){
        if(StrUtil.isBlank(token)) return false;
        String cleanToken = cleanToken(token);
        try {
            Boolean bit = redisTemplate.opsForValue().getBit(KEY + cleanToken, 1);
            return Boolean.TRUE.equals(bit);
        } catch (Exception e) {
            log.error("【黑名单-查询失败】:降级本地缓存{}", cleanToken);
            return localBlackList.getIfPresent(cleanToken) != null;
        }
    }

    private void put(Map.Entry<String, Long> map){
        if(localBlackList.estimatedSize() >= 10000){
            throw new RuntimeException("本地黑名单缓存已满,不接受令牌");
        }
        localBlackList.put(map.getKey(), map.getValue());
    }

    private String cleanToken(String token){
        if (token != null && token.startsWith("Bearer ")) {
            return token.substring("Bearer ".length());
        }
        return token;
    }
}
