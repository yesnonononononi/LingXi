package com.summit.dp.service.domain.model;


import cn.hutool.core.util.PhoneUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.crypto.digest.BCrypt;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.summit.dp.shared.utils.Result;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigInteger;
import java.time.Instant;

@Data
@TableName("users")
@AllArgsConstructor
@Builder
public class User {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String password;
    private String phone;
    private String nick;
    private String avatar;
    private Long accountId;
    private String ip;
    private String ipLocation;
    private Instant createTime;
    private Instant updateTime;


     public class IdUtil{
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

    public void updatePassword(String rawPassword){
        if(rawPassword.isBlank())return;
        this.password = BCrypt.hashpw(rawPassword);
        this.updateTime = Instant.now();
    }

    public boolean matchPassword(String rawPassword) {
        return StrUtil.isNotBlank(rawPassword)
                && StrUtil.isNotBlank(this.password)
                && BCrypt.checkpw(rawPassword, this.password);
    }

    public String getMaskedPhone() {
        if (StrUtil.isBlank(this.phone)) return "";
        return PhoneUtil.hideBetween(this.phone).toString();
    }

    public void encrypt() {
        if (this.password == null) return ;
        this.password = BCrypt.hashpw(this.password);
    }

    public Long mixId() {
        if(this.id == null)return null;
        return IdUtil.mix(this.id);
    }

}
