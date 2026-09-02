package com.summit.dp.auth.domain.model;

import com.baomidou.mybatisplus.annotation.TableField;
import lombok.Getter;

import java.math.BigInteger;

@Getter
public class UserId {
    private final Long value;

    private UserId(Long value) {
        this.value = value;
    }

    public static UserId of(Long value) {
        return new UserId(value);
    }

    public static class IdUtil{
        @TableField(exist = false)
        private static final long MOD = 1_000_000_000L;
        @TableField(exist = false)
        private static final long MULTIPLIER = 387420489L;
        @TableField(exist = false)
        private static final long OFFSET = 100_000_000L;
        @TableField(exist = false)
        private static final long INVERSE;
        static {
            BigInteger mod = BigInteger.valueOf(MOD);
            BigInteger multiplier = BigInteger.valueOf(MULTIPLIER);
            INVERSE = multiplier.modInverse(mod).longValue();
        }
        public static Long mix(long id){
            return (id * MULTIPLIER + OFFSET) % MOD;
        }
        public static Long unMix(long encodedId){
            long raw = (encodedId - OFFSET) % MOD;
            if (raw < 0) raw += MOD;
            return (raw * INVERSE) % MOD;
        }
    }
    public Long mixId() {
        if(this.value== null)return null;
        return IdUtil.mix(this.value);
    }
}
