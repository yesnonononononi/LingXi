package com.summit.dp.user_configs;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.user_configs.api.request.UserConfigRequest;
import com.summit.dp.user_configs.application.command.UserConfigCommand;
import com.summit.dp.user_configs.application.service.DefaultSettingsProvider;
import com.summit.dp.user_configs.application.service.impl.UserConfigServiceImpl;
import com.summit.dp.user_configs.domain.model.UserConfig;
import com.summit.dp.user_configs.domain.repository.UserConfigRepository;
import com.summit.dp.user_configs.infrastructure.fs.SettingsDirectoryMigrator;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 流式输出开关：默认 true、三态贯穿入口与投影、显式关闭能落库。 */
class UserConfigStreamChatTest {

    @Test
    void defaultsToStreamingWhenUnset() {
        // 未设置（null）必须归一为 true，保持历史流式行为。
        assertTrue(UserConfig.defaultConfig().resolveStreamChat());
        assertTrue(UserConfig.builder().build().resolveStreamChat());
    }

    @Test
    void settingTogglesStreamingThroughServiceAndProjection() {
        UserConfig config = UserConfig.defaultConfig();
        UserConfigRepository repository = mock(UserConfigRepository.class);
        when(repository.findSingleton()).thenReturn(Optional.of(config));
        DefaultSettingsProvider provider = new DefaultSettingsProvider(repository, "", 10);
        UserConfigServiceImpl service = new UserConfigServiceImpl(
                repository, null, provider, mock(SettingsDirectoryMigrator.class));
        ReflectionTestUtils.setField(service, "activeDataDir", "/data");

        // 默认投影：true。
        assertTrue(provider.current().orElseThrow().streamChat());
        assertTrue(service.current().getData().getStreamChat());

        // 显式关闭 → 落库 false → 投影 false。
        service.update(command(false, true));
        assertFalse(config.resolveStreamChat());
        assertFalse(provider.current().orElseThrow().streamChat());
        assertFalse(service.current().getData().getStreamChat());

        // 再打开 → true。
        service.update(command(true, true));
        assertTrue(config.resolveStreamChat());
        assertTrue(provider.current().orElseThrow().streamChat());
    }

    @Test
    void missingKeyKeepsPreviousValue() {
        UserConfig config = UserConfig.defaultConfig();
        config.changeStreamChat(false);
        UserConfigRepository repository = mock(UserConfigRepository.class);
        when(repository.findSingleton()).thenReturn(Optional.of(config));
        UserConfigServiceImpl service = new UserConfigServiceImpl(
                repository, null, new DefaultSettingsProvider(repository, "", 10),
                mock(SettingsDirectoryMigrator.class));
        ReflectionTestUtils.setField(service, "activeDataDir", "/data");

        // present=false：即使带了个值也不改。
        service.update(command(true, false));
        assertFalse(config.resolveStreamChat());
    }

    @Test
    void requestDistinguishesMissingFromExplicitValue() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        UserConfigRequest absent = mapper.readValue("{}", UserConfigRequest.class);
        assertFalse(absent.isStreamChatPresent());
        assertNull(absent.getStreamChat());

        UserConfigRequest off = mapper.readValue("{\"streamChat\":false}", UserConfigRequest.class);
        assertTrue(off.isStreamChatPresent());
        assertEquals(Boolean.FALSE, off.getStreamChat());
    }

    private UserConfigCommand command(boolean value, boolean present) {
        return new UserConfigCommand(null, null, null, null, null, null, false, null, null, null,
                null, null, null, null, null, false, null, false, null, false, null, false, null, value, present);
    }
}
