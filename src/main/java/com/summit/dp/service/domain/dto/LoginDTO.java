package com.summit.dp.service.domain.dto;


import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;

@Data
@AllArgsConstructor
@NoArgsConstructor
@Builder
public class LoginDTO implements Serializable {
    private String phoneNumber;
    private String passWord;
}
