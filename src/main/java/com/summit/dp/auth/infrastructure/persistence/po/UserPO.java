package com.summit.dp.auth.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;
@TableName("users")
@Builder
@Data
public class UserPO {
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
}
