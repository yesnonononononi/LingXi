package com.summit.dp.shared.storage;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * 启动期校验矩阵：数据目录形态 × 引擎设置 → 允许启动 / 立刻失败。
 *
 * <p><b>为什么必须在这一层拦住</b>：两个引擎的库文件互不认识。引擎选错时，驱动会照常
 * 建一个空库然后正常启动，用户看到的是「数据全没了」而日志全绿。这里把所有「数据形态与
 * 引擎不符」的组合提前判死，并且**不创建任何文件**。</p>
 *
 * <p>本类是纯函数式判定（除读迁移凭据外无副作用），因此矩阵的每一格都能被单测逐格覆盖。</p>
 */
@Slf4j
public class StorageEngineGuard {

    /** 迁移凭据里「校验通过」的字段名。 */
    private static final String MANIFEST_VERIFIED = "verified";

    /** 迁移凭据里源库 SHA-256 的字段名；源库还在时必须重算比对，这是「手改清单」的检出手段。 */
    private static final String MANIFEST_SOURCE_SHA256 = "sourceSha256";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * 判定数据目录与引擎设置是否自洽。
     *
     * @param layout        数据目录解析结果，不可为 null
     * @param engine        生效引擎，不可为 null
     * @param driverPresent 该引擎的驱动是否在 classpath 上
     * @return 判定结果，绝不返回 {@code null}
     */
    public StorageVerdict verdict(StorageLayout layout, StorageEngine engine, boolean driverPresent) {
        if (layout == null || engine == null) {
            throw new IllegalArgumentException("判定存储形态需要数据目录与引擎，两者都不能为空");
        }
        if (!driverPresent) {
            return StorageVerdict.REJECT_MISSING_DRIVER;
        }
        boolean sqliteData = layout.hasSqliteData();
        boolean h2Data = layout.hasH2Data();
        if (engine == StorageEngine.SQLITE) {
            if (!sqliteData && !h2Data) {
                return StorageVerdict.FIRST_INSTALL;
            }
            if (sqliteData && !h2Data) {
                return StorageVerdict.READY;
            }
            if (!sqliteData) {
                return StorageVerdict.REJECT_H2_DATA_WITH_SQLITE_ENGINE;
            }
            // 两个库都在：即使有迁移凭据也要求显式清理，避免「同一份数据两处都能写」。
            return StorageVerdict.REJECT_AMBIGUOUS_DATA;
        }
        // H2 引擎
        if (!sqliteData && !h2Data) {
            return StorageVerdict.FIRST_INSTALL;
        }
        if (h2Data && !sqliteData) {
            return StorageVerdict.READY;
        }
        if (sqliteData && !h2Data) {
            return StorageVerdict.REJECT_SQLITE_DATA_WITHOUT_MIGRATION;
        }
        return isMigrationVerified(layout) ? StorageVerdict.READY : StorageVerdict.REJECT_AMBIGUOUS_DATA;
    }

    /**
     * 判定并要求可启动：不可启动时抛出带目录、文件清单与处置建议的异常；可启动时确保数据目录可用。
     *
     * @param layout        数据目录解析结果，不可为 null
     * @param engine        生效引擎，不可为 null
     * @param driverPresent 该引擎的驱动是否在 classpath 上
     * @throws IllegalStateException 判定为拒绝启动，或数据目录无法创建/不可写
     */
    public void requireStartable(StorageLayout layout, StorageEngine engine, boolean driverPresent) {
        StorageVerdict verdict = verdict(layout, engine, driverPresent);
        if (!verdict.isStartable()) {
            throw new IllegalStateException(describe(verdict, layout, engine));
        }
        ensureDataDirectory(layout);
    }

    /**
     * 迁移凭据是否可采信。
     *
     * <p>规则（缺一不可）：① {@code verified} 必须为 {@code true}；② 源 SQLite 库仍在时，
     * 必须用清单里的 {@code sourceSha256} 重算比对——这条正是「用户手改清单」的检出手段；
     * ③ 清单读不出来、字段缺失、算法不可用，一律视为不可采信。</p>
     *
     * @param layout 数据目录解析结果
     * @return {@code true} 表示凭据通过校验
     */
    public boolean isMigrationVerified(StorageLayout layout) {
        Path manifest = layout.migrationManifest();
        if (!Files.isRegularFile(manifest)) {
            return false;
        }
        JsonNode root;
        try (InputStream input = Files.newInputStream(manifest)) {
            root = MAPPER.readTree(input);
        } catch (IOException e) {
            log.warn("迁移凭据读取失败，按未验证处理: file={}, reason={}", manifest, e.getMessage());
            return false;
        }
        if (root == null || !root.path(MANIFEST_VERIFIED).asBoolean(false)) {
            log.warn("迁移凭据未标记 verified=true，按未验证处理: file={}", manifest);
            return false;
        }
        String expected = root.path(MANIFEST_SOURCE_SHA256).asText("");
        if (!layout.hasSqliteData()) {
            return true;
        }
        if (expected.isBlank()) {
            log.warn("迁移凭据缺少 sourceSha256，无法与源库比对: file={}", manifest);
            return false;
        }
        String actual = sha256(layout.sqliteFile());
        if (actual == null || !actual.equalsIgnoreCase(expected)) {
            log.warn("迁移凭据的源库指纹与当前 SQLite 库不符（清单可能被手改）: expected={}, actual={}",
                    expected, actual);
            return false;
        }
        return true;
    }

    /** 数据目录必须存在且可写；不存在就建，建不出来即启动失败，不静默回落。 */
    private void ensureDataDirectory(StorageLayout layout) {
        Path directory = layout.dataDir();
        try {
            Files.createDirectories(directory);
        } catch (IOException e) {
            throw new IllegalStateException("数据目录无法创建，应用拒绝以空库启动: dir=" + directory
                    + "，原因=" + e.getMessage(), e);
        }
        if (!Files.isDirectory(directory) || !Files.isWritable(directory)) {
            throw new IllegalStateException("数据目录不可写，应用拒绝启动: dir=" + directory);
        }
    }

    /** 把判定结果翻译成可执行的提示：说清目录、看到哪些文件、下一步该做什么。 */
    private String describe(StorageVerdict verdict, StorageLayout layout, StorageEngine engine) {
        String directory = String.valueOf(layout.dataDir());
        String files = "检测到 sqlite=" + (layout.hasSqliteData() ? layout.sqliteFile() : "无")
                + "，h2=" + (layout.hasH2Data() ? layout.h2File() : "无");
        return switch (verdict) {
            case REJECT_MISSING_DRIVER -> "存储引擎=" + engine.id() + " 但驱动 " + engine.driverClassName()
                    + " 不在 classpath 上：请确认依赖已打包（h2 需要 com.h2database:h2），"
                    + "或把 lingxi.storage.engine 改回 sqlite";
            case REJECT_SQLITE_DATA_WITHOUT_MIGRATION -> "数据目录里只有 SQLite 数据，但引擎设置为 "
                    + engine.id() + "，且没有通过校验的 H2 迁移凭据（" + layout.migrationManifest()
                    + "）：请用 scripts/Migrate-SqliteToH2.ps1 迁移并校验后再启动。dir=" + directory
                    + "，" + files;
            case REJECT_H2_DATA_WITH_SQLITE_ENGINE -> "数据目录里是 H2 库，但引擎设置为 sqlite："
                    + "请显式设置 lingxi.storage.engine=h2，或把该 H2 库移出数据目录。dir=" + directory
                    + "，" + files;
            case REJECT_AMBIGUOUS_DATA -> "数据目录里同时存在 SQLite 与 H2 数据，无法判断以哪一份为准："
                    + "请显式清理其中一个（或重新执行迁移并让凭据通过校验）。dir=" + directory + "，" + files;
            default -> "存储形态判定不允许启动: verdict=" + verdict + "，dir=" + directory + "，" + files;
        };
    }

    /** 流式计算文件 SHA-256（十六进制小写）；读失败返回 {@code null}。 */
    private static String sha256(Path file) {
        if (!Files.isRegularFile(file)) {
            return null;
        }
        try (InputStream input = Files.newInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) > 0) {
                digest.update(buffer, 0, read);
            }
            StringBuilder hex = new StringBuilder(digest.getDigestLength() * 2);
            for (byte value : digest.digest()) {
                hex.append(Character.forDigit((value >> 4) & 0xF, 16));
                hex.append(Character.forDigit(value & 0xF, 16));
            }
            return hex.toString();
        } catch (IOException | NoSuchAlgorithmException e) {
            log.warn("计算文件指纹失败: file={}, reason={}", file, e.getMessage());
            return null;
        }
    }
}
