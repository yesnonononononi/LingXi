package com.summit.dp.user_configs;

import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.user_configs.application.command.UserConfigCommand;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.user_configs.application.service.DefaultSettingsProvider;
import com.summit.dp.user_configs.application.service.impl.UserConfigServiceImpl;
import com.summit.dp.user_configs.domain.model.UserConfig;
import com.summit.dp.user_configs.domain.repository.UserConfigRepository;
import com.summit.dp.user_configs.infrastructure.fs.SettingsDirectoryMigrator;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class SandboxAccessModeTest {
    @Test
    void settingsUpdatePersistsFullAccessWhileKeepingTheSandboxEnvironment() {
        UserConfig config = UserConfig.defaultConfig();
        UserConfigRepository repository = mock(UserConfigRepository.class);
        when(repository.findSingleton()).thenReturn(Optional.of(config));
        DefaultSettingsProvider settingsProvider = new DefaultSettingsProvider(repository, "", 10);
        UserConfigServiceImpl service = new UserConfigServiceImpl(
                repository, mock(ModelService.class), settingsProvider, mock(SettingsDirectoryMigrator.class));
        service.update(new UserConfigCommand(null, "FULL_ACCESS", null, null, null,
                false, null, null, null, null, null, null, null, null, false, null, false));
        verify(repository).updateById(config);
        assertEquals(AgentPermissionMode.FULL_ACCESS, config.getPermissionMode());
        assertEquals(WorkspaceType.SAND_BOX, config.getWorkSpaceConfig().type());
        assertEquals(AgentPermissionMode.FULL_ACCESS, settingsProvider.current().orElseThrow().permissionMode());

        config.changePermissionMode(AgentPermissionMode.DELEGATED_APPROVAL);
        assertEquals(AgentPermissionMode.DELEGATED_APPROVAL, settingsProvider.current().orElseThrow().permissionMode());
    }

    @Test
    void readOnlyReviewIsExcludedFromSessionMenuAndRejectedAsGlobalSetting() {
        assertEquals(
                List.of(AgentPermissionMode.APPROVAL_REQUIRED, AgentPermissionMode.DELEGATED_APPROVAL, AgentPermissionMode.FULL_ACCESS),
                AgentPermissionMode.selectableModes()
        );
        assertFalse(AgentPermissionMode.READ_ONLY_REVIEW.isVisibleInSessionMenu());
        assertEquals(AgentPermissionMode.READ_ONLY_REVIEW,
                AgentPermissionMode.resolveEffective(AgentPermissionMode.FULL_ACCESS, true));
        assertEquals(AgentPermissionMode.DELEGATED_APPROVAL,
                AgentPermissionMode.resolveEffective(AgentPermissionMode.DELEGATED_APPROVAL, false));

        UserConfig config = UserConfig.defaultConfig();
        UserConfigRepository repository = mock(UserConfigRepository.class);
        when(repository.findSingleton()).thenReturn(Optional.of(config));
        DefaultSettingsProvider settingsProvider = new DefaultSettingsProvider(repository, "", 10);
        UserConfigServiceImpl service = new UserConfigServiceImpl(
                repository, mock(ModelService.class), settingsProvider, mock(SettingsDirectoryMigrator.class));
        assertThrows(ClientException.class, () -> service.update(new UserConfigCommand(
                null, "READ_ONLY_REVIEW", null, null, null,
                false, null, null, null, null, null, null, null, null, false, null, false)));
    }
}
