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

/** 未迁移的旧数据必须在建库前拒绝，避免升级后看见空会话。 */
@Slf4j
public class StorageEngineGuard {

    /** 迁移凭据里「校验通过」的字段名。 */
    private static final String MANIFEST_VERIFIED = "verified";

    /** 迁移凭据里源库 SHA-256 的字段名；源库还在时必须重算比对，这是「手改清单」的检出手段。 */
    private static final String MANIFEST_SOURCE_SHA256 = "sourceSha256";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    public StorageVerdict verdict(StorageLayout layout, boolean driverPresent) {
        if (layout == null) {
            throw new IllegalArgumentException("判定存储形态需要数据目录");
        }
        if (!driverPresent) {
            return StorageVerdict.REJECT_MISSING_DRIVER;
        }
        boolean legacyData = layout.hasLegacySqliteData();
        boolean h2Data = layout.hasH2Data();
        if (!legacyData && !h2Data) {
            return StorageVerdict.FIRST_INSTALL;
        }
        if (!legacyData) {
            return StorageVerdict.READY;
        }
        if (!h2Data) {
            return StorageVerdict.REJECT_LEGACY_SQLITE_DATA;
        }
        return isMigrationVerified(layout) ? StorageVerdict.READY : StorageVerdict.REJECT_AMBIGUOUS_DATA;
    }

    public void requireStartable(StorageLayout layout, boolean driverPresent) {
        StorageVerdict verdict = verdict(layout, driverPresent);
        if (!verdict.isStartable()) {
            throw new IllegalStateException(describe(verdict, layout));
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
        if (!layout.hasLegacySqliteData()) {
            return true;
        }
        if (expected.isBlank()) {
            log.warn("迁移凭据缺少 sourceSha256，无法与源库比对: file={}", manifest);
            return false;
        }
        String actual = sha256(layout.legacySqliteFile());
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

    private String describe(StorageVerdict verdict, StorageLayout layout) {
        String location = "数据目录=" + layout.dataDir() + "，H2 库=" + layout.databaseFile();
        return switch (verdict) {
            case REJECT_MISSING_DRIVER -> "缺少 H2 驱动 " + H2Storage.DRIVER_CLASS_NAME
                    + "：请重新安装包含 com.h2database:h2 的完整应用。" + location;
            case REJECT_LEGACY_SQLITE_DATA -> "检测到未迁移的 SQLite 数据，应用已停止启动，未创建空 H2 库。"
                    + "请先停止旧版应用，备份整个数据与配置目录，再执行 scripts/Migrate-SqliteToH2.ps1"
                    + " -Source <旧库副本> -Target <空目标目录>，校验通过后离线修改配置中的 dataDir。" + location;
            case REJECT_AMBIGUOUS_DATA -> "SQLite 与 H2 数据同时存在，但迁移凭据缺失或源库指纹不符。"
                    + "请保留两份数据，停止应用并重新迁移、校验；不要删除旧库来绕过校验。" + location;
            default -> "存储目录不可启动: verdict=" + verdict + "，" + location;
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
