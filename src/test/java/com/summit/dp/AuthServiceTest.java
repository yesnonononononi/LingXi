package com.summit.dp;

import cn.hutool.crypto.digest.BCrypt;
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
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Mockito;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Duration;
import java.time.Instant;

@ExtendWith(MockitoExtension.class)
@DisplayName("认证服务企业级单元测试套件")
public class AuthServiceTest {

    @Mock
    private UserMapper userMapper;

    @Mock
    private AuthCacheProvider cacheProvider;

    @InjectMocks
    private AuthServiceImpl authService;

    // 测试常量定义
    private static final String VALID_PHONE = "18573757527";
    private static final String VALID_RAW_PASSWORD = "password12345";
    private static final String VALID_HASH_PASSWORD = BCrypt.hashpw(VALID_RAW_PASSWORD);
    private static final String MOCK_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.mock_signature";

    @BeforeEach
    public void setUp() {
        ReflectionTestUtils.setField(authService, "baseMapper", userMapper);
        // 清理线程上下文环境，防止测试间相互污染
        UserContext.set(AuthSession.builder().build());
    }

    @Nested
    @DisplayName("1. 用户登录测试模块")
    class LoginTests {

        @Test
        @DisplayName("登录成功 - 手机号密码正确，成功返回 Token")
        public void should_LoginSuccess_When_CredentialsAreValid() {
            User mockUser = User.builder()
                    .id(1001L)
                    .phone(VALID_PHONE)
                    .password(VALID_RAW_PASSWORD)
                    .build();
            mockUser.encrypt();
            Mockito.when(userMapper.selectOne(Mockito.any(LambdaQueryWrapper.class))).thenReturn(mockUser);

            LoginDTO dto = LoginDTO.builder()
                    .phoneNumber(VALID_PHONE)
                    .passWord(VALID_RAW_PASSWORD)
                    .build();

            Result<AuthVO> result = authService.login(dto);

            Assertions.assertEquals(200, result.getCode());
            Assertions.assertNotNull(result.getData());
            Assertions.assertNotNull(result.getData().getToken());
        }

        @Test
        @DisplayName("登录失败 - 密码为空")
        public void should_ReturnError_When_PasswordIsEmpty() {
            LoginDTO dto = LoginDTO.builder()
                    .phoneNumber(VALID_PHONE)
                    .passWord("")
                    .build();

            Result<AuthVO> result = authService.login(dto);

            Assertions.assertEquals(0, result.getCode());
            Assertions.assertEquals("密码不能为空", result.getErrMsg());
        }

        @Test
        @DisplayName("登录失败 - 手机号格式不正确")
        public void should_ReturnError_When_PhoneIsInvalid() {
            LoginDTO dto = LoginDTO.builder()
                    .phoneNumber("12345")
                    .passWord(VALID_RAW_PASSWORD)
                    .build();

            Result<AuthVO> result = authService.login(dto);

            Assertions.assertEquals(0, result.getCode());
            Assertions.assertEquals("请输入正确的手机号码", result.getErrMsg());
        }

        @Test
        @DisplayName("登录失败 - 用户不存在")
        public void should_ReturnError_When_UserNotFound() {
            Mockito.when(userMapper.selectOne(Mockito.any(LambdaQueryWrapper.class))).thenReturn(null);

            LoginDTO dto = LoginDTO.builder()
                    .phoneNumber(VALID_PHONE)
                    .passWord(VALID_RAW_PASSWORD)
                    .build();

            Result<AuthVO> result = authService.login(dto);

            Assertions.assertEquals(0, result.getCode());
            Assertions.assertEquals("未找到用户信息", result.getErrMsg());
        }

        @Test
        @DisplayName("登录失败 - 密码错误")
        public void should_ReturnError_When_PasswordIsIncorrect() {
            User mockUser = User.builder()
                    .id(1001L)
                    .phone(VALID_PHONE)
                    .password(VALID_RAW_PASSWORD)
                    .build();
            mockUser.encrypt();
            Mockito.when(userMapper.selectOne(Mockito.any(LambdaQueryWrapper.class))).thenReturn(mockUser);

            LoginDTO dto = LoginDTO.builder()
                    .phoneNumber(VALID_PHONE)
                    .passWord("wrong_password")
                    .build();

            Result<AuthVO> result = authService.login(dto);

            Assertions.assertEquals(0, result.getCode());
            Assertions.assertEquals("密码错误", result.getErrMsg());
        }
    }

    @Nested
    @DisplayName("2. 用户注册测试模块")
    class RegisterTests {

        @Test
        @DisplayName("注册成功 - 参数合法，成功创建用户")
        public void should_RegisterSuccess_When_ParamsValid() {
            RegisterDTO dto = RegisterDTO.builder()
                    .phoneNumber(VALID_PHONE)
                    .password(VALID_RAW_PASSWORD)
                    .smsCode(123456)
                    .build();

            Result<Void> result = authService.register(dto);

            Assertions.assertEquals(200, result.getCode());

            ArgumentCaptor<User> userCaptor = ArgumentCaptor.forClass(User.class);
            Mockito.verify(userMapper, Mockito.times(1)).insert(userCaptor.capture());
            Assertions.assertEquals(VALID_PHONE, userCaptor.getValue().getPhone());
        }

        @Test
        @DisplayName("注册失败 - 密码长度不足10位")
        public void should_ReturnError_When_PasswordTooShort() {
            RegisterDTO dto = RegisterDTO.builder()
                    .phoneNumber(VALID_PHONE)
                    .password("short123")
                    .smsCode(123456)
                    .build();

            Result<Void> result = authService.register(dto);

            Assertions.assertEquals(0, result.getCode());
            Assertions.assertEquals("请输入正确的密码格式", result.getErrMsg());
        }

        @Test
        @DisplayName("注册失败 - 用户已存在(数据库唯一索引冲突)")
        public void should_ReturnError_When_UserAlreadyExists() {
            RegisterDTO dto = RegisterDTO.builder()
                    .phoneNumber(VALID_PHONE)
                    .password(VALID_RAW_PASSWORD)
                    .smsCode(123456)
                    .build();

            Mockito.doThrow(new DuplicateKeyException("Duplicate entry"))
                    .when(userMapper).insert(Mockito.any(User.class));

            Result<Void> result = authService.register(dto);

            Assertions.assertEquals(0, result.getCode());
            Assertions.assertEquals("用户已存在,请登录", result.getErrMsg());
        }
    }

    @Nested
    @DisplayName("3. 用户登出测试模块")
    class LogoutTests {

        @Test
        @DisplayName("登出成功 - 有效 Token 正常加入黑名单")
        public void should_LogoutSuccess_When_SessionIsValid() {
            AuthSession session = AuthSession.builder()
                    .userId(1001L)
                    .uname("185****7527")
                    .token(MOCK_TOKEN)
                    .expireTime(Instant.now().plusSeconds(3600))
                    .build();
            UserContext.set(session);

            Result<Void> result = authService.logout();

            Assertions.assertEquals(200, result.getCode());
            Mockito.verify(cacheProvider, Mockito.times(1)).put(Mockito.eq(MOCK_TOKEN), Mockito.any(Duration.class));
        }

        @Test
        @DisplayName("登出成功 - 过期 Token 不触发黑名单写入")
        public void should_LogoutSuccess_Without_Cache_When_TokenAlreadyExpired() {
            AuthSession expiredSession = AuthSession.builder()
                    .userId(1001L)
                    .uname("185****7527")
                    .token(MOCK_TOKEN)
                    .expireTime(Instant.now().minusSeconds(60))
                    .build();
            UserContext.set(expiredSession);

            Result<Void> result = authService.logout();

            Assertions.assertEquals(200, result.getCode());
            Mockito.verify(cacheProvider, Mockito.never()).put(Mockito.anyString(), Mockito.any(Duration.class));
        }
    }
}
