package com.summit.dp.auth.domain.model;


import cn.hutool.core.util.PhoneUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.crypto.digest.BCrypt;
import com.baomidou.mybatisplus.annotation.TableField;
import com.summit.ddd.domain.model.AggregateRoot;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.EqualsAndHashCode;

import java.math.BigInteger;
import java.time.Instant;

@EqualsAndHashCode(callSuper = true)
@Data
@AllArgsConstructor
public class User extends AggregateRoot {
    private UserId id;
    private String password;
    private String phone;
    private String nick;
    private String avatar;
    private Long accountId;
    private String ip;
    private String ipLocation;
    private Instant createTime;
    private Instant updateTime;


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



}
