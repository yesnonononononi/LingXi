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

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * 指令预测模型设置的落库守护。
 *
 * <p>与压缩模型同口径：显式 null 等于「关闭」、不传保持原值、凭据不齐不许落库；
 * 但字段独立，两处设置互不影响。</p>
 */
class UserConfigPredicateModelTest {

    private static final long PREDICATE_MODEL_ID = 11L;

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
    @DisplayName("选中指令预测模型：落库并回显，且不影响压缩模型")
    void predicateModelIsPersistedIndependently() {
        when(modelService.findById(PREDICATE_MODEL_ID)).thenReturn(Result.success(model(true)));

        service.update(command(PREDICATE_MODEL_ID, true));

        assertEquals(PREDICATE_MODEL_ID, config.getPredicateModelId());
        assertNull(config.getCompactModelId());
        assertEquals(PREDICATE_MODEL_ID, service.current().getData().getPredicateModelId());
        verify(repository).updateById(config);
    }

    @Test
    @DisplayName("显式传 null：关闭指令预测（而不是保持原值）")
    void explicitNullClearsThePredicateModel() {
        config.changePredicateModel(PREDICATE_MODEL_ID);

        service.update(command(null, true));

        assertNull(config.getPredicateModelId());
        verify(repository).updateById(config);
    }

    @Test
    @DisplayName("请求里没带这个字段：保持原值")
    void omittedFieldKeepsTheStoredValue() {
        config.changePredicateModel(PREDICATE_MODEL_ID);

        service.update(command(null, false));

        assertEquals(PREDICATE_MODEL_ID, config.getPredicateModelId());
    }

    @Test
    @DisplayName("预测模型缺凭据：拒绝落库")
    void modelWithoutCredentialIsRejected() {
        when(modelService.findById(PREDICATE_MODEL_ID)).thenReturn(Result.success(model(false)));

        assertThrows(ClientException.class, () -> service.update(command(PREDICATE_MODEL_ID, true)));

        verify(repository, never()).updateById(any());
        assertNull(config.getPredicateModelId());
    }

    private static ModelConfigVO model(boolean credentialConfigured) {
        return ModelConfigVO.builder().credentialConfigured(credentialConfigured).build();
    }

    private static UserConfigCommand command(Long predicateModelId, boolean present) {
        return new UserConfigCommand(null, null, null, null, null, null, false, null, null, null,
                null, null, null, null, null, false, predicateModelId, present, null, false, null,
                false, null, null, false);
    }
}
