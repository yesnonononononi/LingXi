package com.summit.dp.user_configs;

import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.user_configs.application.command.UserConfigCommand;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.service.DefaultSettingsProvider;
import com.summit.dp.user_configs.application.service.impl.UserConfigServiceImpl;
import com.summit.dp.user_configs.domain.model.UserConfig;
import com.summit.dp.user_configs.domain.repository.UserConfigRepository;
import com.summit.dp.user_configs.infrastructure.fs.SettingsDirectoryMigrator;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
        service.update(new UserConfigCommand(null, null, "OUT_OF_WORKSPACE", null, null, null,
                false, null, null, null, null, null, null, null, null, false));
        verify(repository).updateById(config);
        assertEquals(UserConfig.AccessMode.OUT_OF_WORKSPACE, config.getAccessMode());
        assertEquals(WorkspaceType.SAND_BOX, config.getWorkSpaceConfig().type());
        assertEquals(AgentAccessMode.OUT_OF_WORKSPACE, settingsProvider.current().orElseThrow().accessMode());

        config.changeAccessMode(UserConfig.AccessMode.READ_ONLY_IN_WORKSPACE);
        assertEquals(AgentAccessMode.READ_ONLY_IN_WORKSPACE, settingsProvider.current().orElseThrow().accessMode());
    }
}
