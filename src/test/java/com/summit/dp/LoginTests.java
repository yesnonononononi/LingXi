package com.summit.dp;

import com.summit.dp.persistence.mapper.user.UserMapper;
import com.summit.dp.service.auth.AuthService;
import com.summit.dp.service.auth.impl.AuthServiceImpl;
import com.summit.dp.service.domain.dto.LoginDTO;
import com.summit.dp.service.domain.exception.ClientException;
import com.summit.dp.service.domain.model.User;
import com.summit.dp.service.domain.vo.AuthVO;
import com.summit.dp.shared.utils.Result;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Mockito;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
public class LoginTests {

    @Mock
    private UserMapper userMapper;

    @InjectMocks
    private AuthServiceImpl authService;

    // 真实可用的密码密文，对应明文 12334465
    private static final String VALID_PASSWORD_HASH = "$2a$10$9kmffOx9yHtx/gupBRr9G.i.PvJWcUIgoC21WN6/6j5nkS9CQqrLS";
    private static final String PHONE = "18573757527";
    private static final String PASSWORD = "12334465";

    // ---- DTO 自身校验（通常由框架或静态工厂完成，此处仅展示边界） ----
    @Test
    void testDtoValidation() {
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO("18573757527", null));
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO("18573757527", ""));
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO(null, ""));
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO("", "12334465"));
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO("1381234", "123456"));
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO("138123456789", "123456"));
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO("1381234abcd", "123456"));
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO("23812345678", "123456"));
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO("138-1234-5678", "123456"));
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO("00000000000", "123456"));
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO("18573757527", "a".repeat(129)));
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO("18573757527", "   "));
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO(null, "12345"));
        Assertions.assertThrows(ClientException.class, () -> new LoginDTO("12345", null));
    }

    // ---- 正常登录 ----
    @Test
    void testLoginSuccess() {
        User user = User.builder().id(1L).password(VALID_PASSWORD_HASH).phone(PHONE).build();
        Mockito.when(userMapper.selectOne(Mockito.any())).thenReturn(user);

        LoginDTO dto = new LoginDTO(PHONE, PASSWORD);
        Result<AuthVO> result = authService.login(dto);

        Assertions.assertNotNull(result);
        Assertions.assertEquals(200, result.getCode()); // 假设成功码为200
        Assertions.assertNotNull(result.getData());
        Assertions.assertNotNull(result.getData().getToken());
    }

    // ---- 用户不存在 ----
    @Test
    void testLoginUserNotFound() {
        Mockito.when(userMapper.selectOne(Mockito.any())).thenReturn(null);

        LoginDTO dto = new LoginDTO(PHONE, PASSWORD);
        Result<AuthVO> result = authService.login(dto);

        Assertions.assertNotNull(result);
        Assertions.assertNotEquals(200, result.getCode());
    }

    // ---- 密码错误 ----
    @Test
    void testLoginWrongPassword() {
        User user = User.builder().id(1L).password(VALID_PASSWORD_HASH).phone(PHONE).build();
        Mockito.when(userMapper.selectOne(Mockito.any())).thenReturn(user);

        LoginDTO dto = new LoginDTO(PHONE, "wrongPassword");
        Result<AuthVO> result = authService.login(dto);

        Assertions.assertNotNull(result);
        Assertions.assertNotEquals(200, result.getCode());
    }



    // ---- 用户密码字段为空（防御性测试） ----
    @Test
    void testLoginPasswordNullInDb() {
        User user = User.builder().id(1L).password(null).phone(PHONE).build();
        Mockito.when(userMapper.selectOne(Mockito.any())).thenReturn(user);

        LoginDTO dto = new LoginDTO(PHONE, PASSWORD);
        Result<AuthVO> result = authService.login(dto);

        Assertions.assertNotNull(result);
        // 不应崩溃，返回系统错误或密码错误
        Assertions.assertNotEquals(200, result.getCode());
    }



    // ---- 返回 token 非空校验 ----
    @Test
    void testLoginReturnsToken() {
        User user = User.builder().id(1L).password(VALID_PASSWORD_HASH).phone(PHONE).build();
        Mockito.when(userMapper.selectOne(Mockito.any())).thenReturn(user);

        Result<AuthVO> result = authService.login(new LoginDTO(PHONE, PASSWORD));
        System.out.println(result);
        Assertions.assertNotNull(result.getData());

    }


}