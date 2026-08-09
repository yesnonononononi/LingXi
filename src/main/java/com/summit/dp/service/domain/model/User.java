package com.summit.dp.service.domain.model;

import cn.hutool.core.util.IdUtil;
import cn.hutool.core.util.PhoneUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.crypto.digest.BCrypt;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Objects;

@Data
@TableName("users")
@AllArgsConstructor
@NoArgsConstructor
@Builder
public class User {
    @TableId(type = IdType.INPUT)
    private Long id;
    private String password;
    private String phone;

    public boolean matchPassword(String rawPassword) {
        return StrUtil.isNotBlank(rawPassword) 
                && StrUtil.isNotBlank(this.password) 
                && BCrypt.checkpw(rawPassword, this.password);
    }

    public static String encryptPassword(String rawPassword) {
        return StrUtil.isBlank(rawPassword) ? "" : BCrypt.hashpw(rawPassword);
    }

    public String getMaskedPhone() {
        if (StrUtil.isBlank(this.phone)) return "";
        return PhoneUtil.hideBetween(this.phone).toString();
    }

    public User rebuildId(){
        Long rId = Objects.requireNonNullElse(this.id, IdUtil.getSnowflakeNextId());
        this.id = (long) rId.hashCode();
        return this;
    }
}
