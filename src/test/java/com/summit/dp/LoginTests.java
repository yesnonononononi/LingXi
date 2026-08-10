package com.summit.dp;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.summit.dp.persistence.mapper.user.UserMapper;
import com.summit.dp.service.auth.AuthCacheProvider;
import com.summit.dp.service.auth.impl.AuthServiceImpl;
import com.summit.dp.service.domain.dto.LoginDTO;
import com.summit.dp.service.domain.dto.RegisterDTO;
import com.summit.dp.service.domain.model.User;
import com.summit.dp.service.domain.model.auth.AuthSession;
import com.summit.dp.service.domain.vo.AuthVO;
import com.summit.dp.shared.utils.Result;
import com.summit.dp.shared.utils.UserContext;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Mockito;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Instant;

@ExtendWith(MockitoExtension.class)
public class LoginTests {

    @Mock
    private UserMapper userMapper;
    @Mock
    private AuthCacheProvider cacheProvider;
    @InjectMocks
    private AuthServiceImpl authService;

    // 真实可用的密码密文，对应明文 12334465
    private static final String VALID_PASSWORD_HASH = "$2a$10$9kmffOx9yHtx/gupBRr9G.i.PvJWcUIgoC21WN6/6j5nkS9CQqrLS";
    private static final String PHONE = "18573757527";
    private static final String PASSWORD = "12334465";

    @BeforeEach
    public void setUp() {
        ReflectionTestUtils.setField(authService, "baseMapper", userMapper);
    }

    @Test
    public void testLogin() {
        User user = User.builder()
                .id(1L)
                .phone(PHONE)
                .password(VALID_PASSWORD_HASH)
                .build();
        Mockito.when(userMapper.selectOne(Mockito.any(LambdaQueryWrapper.class))).thenReturn(user);
        LoginDTO dto = LoginDTO.builder()
                .phoneNumber(PHONE)
                .passWord(PASSWORD)
                .build();
        Result<AuthVO> login = authService.login(dto);
        Assertions.assertInstanceOf(Result.class, login);
        Assertions.assertEquals(200, login.getCode());
        AuthVO data = login.getData();
        Assertions.assertInstanceOf(AuthVO.class, data);
        Assertions.assertNotNull(data.getToken());
    }

    @Test
    public void testLogout() {
        String token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0ODc0MjA0ODkiLCJ1bmFtZSI6IjE4NSoqKio3NTI3IiwiZXhwIjoxNzg2OTU2MTkxfQ.V5IUErBg5byQo_vHTfUHN8wicFtNfDSLBjQMnuasUKQ";
        AuthSession session = AuthSession.builder()
                .userId(1L)
                .uname("185****7527")
                .token(token)
                .expireTime(Instant.now().plusSeconds(3600))
                .build();
        UserContext.set(session);

        Result<Void> res = authService.logout();

        Assertions.assertInstanceOf(Result.class, res);
        Assertions.assertEquals(200, res.getCode());
        Mockito.verify(cacheProvider, Mockito.times(1)).put(Mockito.eq(token), Mockito.any());
    }

    @Test
    public void testRegister() {
        Mockito.when(userMapper.insert(Mockito.any(User.class))).thenReturn(1);
        RegisterDTO dto = RegisterDTO.builder()
                .smsCode(200000)
                .password(PASSWORD+"1213123")
                .phoneNumber(PHONE)
                .build();
        Result<Void> res = authService.register(dto);
        Assertions.assertInstanceOf(Result.class, res);
        Assertions.assertEquals(200, res.getCode());
    }



}