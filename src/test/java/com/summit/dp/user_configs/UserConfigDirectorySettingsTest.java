package com.summit.dp.user_configs;

import com.summit.dp.model.application.service.ModelService;
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
import org.mockito.InOrder;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 设置页三个新字段（dataDir / skillDir / teamSize）的落库行为守卫。
 *
 * <p>核心不变量只有一条：<b>搬迁必须先于落库</b>。反过来的话，搬迁失败时配置已经指向新目录，
 * 用户看到的是「数据全没了」—— 这类顺序错误读代码看不出来，只能靠 inOrder 断言钉住。</p>
 */
class UserConfigDirectorySettingsTest {

    private static final String ACTIVE_DATA_DIR = "/data/current";

    private UserConfigRepository repository;
    private SettingsDirectoryMigrator migrator;
    private UserConfigServiceImpl service;
    private UserConfig config;

    @BeforeEach
    void setUp() {
        config = UserConfig.defaultConfig();
        repository = mock(UserConfigRepository.class);
        when(repository.findSingleton()).thenReturn(Optional.of(config));
        migrator = mock(SettingsDirectoryMigrator.class);
        DefaultSettingsProvider settingsProvider = new DefaultSettingsProvider(repository, "", 10);
        service = new UserConfigServiceImpl(repository, mock(ModelService.class), settingsProvider, migrator);
        ReflectionTestUtils.setField(service, "activeDataDir", ACTIVE_DATA_DIR);
    }

    @Test
    @DisplayName("改数据目录：先搬库文件，再落新位置")
    void dataDirChangeMovesFilesBeforePersistingNewLocation() {
        service.update(command(null, "/data/new", null));

        InOrder order = inOrder(migrator, repository);
        order.verify(migrator).migrateDataDir(ACTIVE_DATA_DIR, "/data/new");
        order.verify(repository).updateById(config);
        assertEquals("/data/new", config.getDataDir());
    }

    @Test
    @DisplayName("搬迁失败：抛错且不落库，配置仍指向旧目录")
    void failedMigrationLeavesStoredLocationUntouched() {
        doThrow(new ClientException("磁盘满了")).when(migrator).migrateDataDir(anyString(), anyString());

        assertThrows(ClientException.class, () -> service.update(command(null, "/data/new", null)));

        verify(repository, never()).updateById(any());
        assertNull(config.getDataDir());
    }

    @Test
    @DisplayName("改技能目录：先搬内容，再落新位置")
    void skillDirChangeCopiesContentBeforePersistingNewLocation() {
        service.update(command("/skills/new", null, null));

        InOrder order = inOrder(migrator, repository);
        // 原来没有生效的技能目录（设置行与 yaml 都为空）⇒ 来源为 null，搬迁方按「无内容可搬」处理。
        order.verify(migrator).migrateSkillDir(null, "/skills/new");
        order.verify(repository).updateById(config);
        assertEquals("/skills/new", config.getSkillDir());
    }

    @Test
    @DisplayName("目录重复提交（与当前生效值相同）也要走搬迁入口，由搬迁方幂等跳过")
    void repeatedSameDirectoryStillGoesThroughMigrator() {
        config.changeDataDir("/data/new");
        service.update(command(null, "/data/new", null));

        verify(migrator).migrateDataDir("/data/new", "/data/new");
    }

    @Test
    @DisplayName("团队规模上限：区间外拒绝，区间内落库")
    void teamSizeOutsideRangeIsRejected() {
        assertThrows(ClientException.class, () -> service.update(command(null, null, 0)));
        assertThrows(ClientException.class, () -> service.update(command(null, null, UserConfig.MAX_TEAM_SIZE + 1)));

        service.update(command(null, null, 20));
        assertEquals(20, config.getTeamSize());
    }

    @Test
    @DisplayName("目录长度超列宽即拒绝，不让它变成落库时的静默截断")
    void overlongDirectoryIsRejectedBeforeMigration() {
        String tooLong = "/data/" + "x".repeat(UserConfig.MAX_DIRECTORY_LENGTH);

        assertThrows(ClientException.class, () -> service.update(command(null, tooLong, null)));
        verify(migrator, never()).migrateDataDir(anyString(), anyString());
    }

    @Test
    @DisplayName("待重启标记：生效目录 ≠ 本进程打开的目录时为真")
    void restartIsRequiredOnlyWhenEffectiveDirDiffersFromTheOpenOne() {
        assertFalse(service.current().getData().getDataDirRestartRequired());

        service.update(command(null, "/data/new", null));

        assertTrue(service.current().getData().getDataDirRestartRequired());
        assertEquals("/data/new", service.current().getData().getDataDir());
    }

    private static UserConfigCommand command(String skillDir, String dataDir, Integer teamSize) {
        return new UserConfigCommand(null, null, null, null, null, null, false, null, null, null, null,
                dataDir, skillDir, teamSize, null, false);
    }
}
