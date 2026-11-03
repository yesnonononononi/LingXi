package com.summit.dp.user_configs;

import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.user_configs.application.command.UserConfigCommand;
import com.summit.dp.user_configs.application.service.DefaultSettingsProvider;
import com.summit.dp.user_configs.application.service.impl.UserConfigServiceImpl;
import com.summit.dp.user_configs.domain.model.ReasoningEffort;
import com.summit.dp.user_configs.domain.model.UserConfig;
import com.summit.dp.user_configs.domain.repository.UserConfigRepository;
import com.summit.dp.user_configs.infrastructure.fs.SettingsDirectoryMigrator;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 思考强度入参的校验口径。
 *
 * <p>非法档位此前落进 {@code Objects.requireNonNull}，前端拿到的是 500 + 空指针堆栈 ——
 * 用户看不出哪个值不合法，日志里也没有业务语义。这里钉住：非法值必须是中文业务提示，
 * 且**一个字段都不许落库**（半截保存比报错更难查）。</p>
 */
class UserConfigReasoningEffortTest {

    private UserConfigRepository repository;
    private UserConfigServiceImpl service;
    private UserConfig config;

    @BeforeEach
    void setUp() {
        config = UserConfig.defaultConfig();
        repository = mock(UserConfigRepository.class);
        when(repository.findSingleton()).thenReturn(Optional.of(config));
        service = new UserConfigServiceImpl(repository, mock(ModelService.class),
                new DefaultSettingsProvider(repository, "", 10), mock(SettingsDirectoryMigrator.class));
        ReflectionTestUtils.setField(service, "activeDataDir", "/data/current");
    }

    @Test
    @DisplayName("非法档位：中文业务提示，且不落库")
    void unknownEffortFailsWithBusinessMessage() {
        ClientException error = assertThrows(ClientException.class,
                () -> service.update(command("ultra")));

        assertTrue(error.getMessage().contains("思考强度"), "提示必须说清是哪个字段: " + error.getMessage());
        assertTrue(error.getMessage().contains("ultra"), "提示必须带上收到的值: " + error.getMessage());
        assertEquals(ReasoningEffort.LOW, config.getReasoningEffort(), "校验失败不许改动已存值");
        verify(repository, never()).updateById(config);
    }

    @Test
    @DisplayName("合法档位照常落库")
    void knownEffortIsPersisted() {
        service.update(command("xhigh"));

        assertEquals(ReasoningEffort.XHIGH, config.getReasoningEffort());
        verify(repository).updateById(config);
    }

    @Test
    @DisplayName("未传档位不改动原值")
    void absentEffortKeepsStoredValue() {
        service.update(command(null));

        assertEquals(ReasoningEffort.LOW, config.getReasoningEffort());
    }

    private static UserConfigCommand command(String reasoningEffort) {
        return new UserConfigCommand(null, null, null, null, null, null, false, null, null,
                reasoningEffort, null, null, null, null, null, false, null, false);
    }
}
