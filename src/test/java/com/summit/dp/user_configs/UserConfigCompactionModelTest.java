package com.summit.dp.user_configs;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.vo.ModelConfigVO;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.user_configs.application.command.UserConfigCommand;
import com.summit.dp.user_configs.application.service.DefaultSettingsProvider;
import com.summit.dp.user_configs.application.service.impl.UserConfigServiceImpl;
import com.summit.dp.user_configs.domain.model.UserConfig;
import com.summit.dp.user_configs.domain.repository.UserConfigRepository;
import com.summit.dp.user_configs.infrastructure.fs.SettingsDirectoryMigrator;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 专用压缩模型设置的落库守护。
 *
 * <p>这里钉三件事：显式 null 等于「取消」（与「没传」不同）、没传就不许覆盖原值、
 * 凭据不齐的模型不许落库 —— 最后一条的理由是它会让压缩在对话中途失败，用户无从定位。</p>
 */
class UserConfigCompactionModelTest {

    private static final long COMPACT_MODEL_ID = 9L;

    private UserConfigRepository repository;
    private ModelService modelService;
    private UserConfigServiceImpl service;
    private UserConfig config;

    @BeforeEach
    void setUp() {
        config = UserConfig.defaultConfig();
        repository = mock(UserConfigRepository.class);
        when(repository.findSingleton()).thenReturn(Optional.of(config));
        modelService = mock(ModelService.class);
        service = new UserConfigServiceImpl(repository, modelService,
                new DefaultSettingsProvider(repository, "", 10), mock(SettingsDirectoryMigrator.class));
        ReflectionTestUtils.setField(service, "activeDataDir", "/data/current");
    }

    @Test
    @DisplayName("选中专用压缩模型：落库并回显")
    void dedicatedCompactModelIsPersisted() {
        when(modelService.findById(COMPACT_MODEL_ID)).thenReturn(Result.success(model(true)));

        service.update(command(COMPACT_MODEL_ID, true));

        assertEquals(COMPACT_MODEL_ID, config.getCompactModelId());
        assertEquals(COMPACT_MODEL_ID, service.current().getData().getCompactModelId());
        verify(repository).updateById(config);
    }

    @Test
    @DisplayName("显式传 null：取消专用压缩模型（而不是保持原值）")
    void explicitNullClearsTheDedicatedCompactModel() {
        config.changeCompactModel(COMPACT_MODEL_ID);

        service.update(command(null, true));

        assertNull(config.getCompactModelId());
        verify(repository).updateById(config);
    }

    @Test
    @DisplayName("请求里没带这个字段：保持原值")
    void omittedFieldKeepsTheStoredValue() {
        config.changeCompactModel(COMPACT_MODEL_ID);

        service.update(command(null, false));

        assertEquals(COMPACT_MODEL_ID, config.getCompactModelId());
    }

    @Test
    @DisplayName("压缩模型缺凭据：拒绝落库")
    void modelWithoutCredentialIsRejected() {
        when(modelService.findById(COMPACT_MODEL_ID)).thenReturn(Result.success(model(false)));

        assertThrows(ClientException.class, () -> service.update(command(COMPACT_MODEL_ID, true)));

        verify(repository, never()).updateById(any());
        assertNull(config.getCompactModelId());
    }

    private static ModelConfigVO model(boolean credentialConfigured) {
        return ModelConfigVO.builder().credentialConfigured(credentialConfigured).build();
    }

    private static UserConfigCommand command(Long compactModelId, boolean present) {
        return new UserConfigCommand(null, null, null, null, null, null, false, null, null, null, null,
                null, null, null, compactModelId, present);
    }
}
