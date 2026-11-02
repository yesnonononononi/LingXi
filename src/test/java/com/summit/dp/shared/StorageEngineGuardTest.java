package com.summit.dp.shared;

import com.summit.dp.shared.storage.StorageEngineGuard;
import com.summit.dp.shared.storage.StorageLayout;
import com.summit.dp.shared.storage.StorageVerdict;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;

import static org.junit.jupiter.api.Assertions.*;

class StorageEngineGuardTest {
    @TempDir Path directory;
    private final StorageEngineGuard guard = new StorageEngineGuard();

    @Test
    void freshDirectoryIsCreatedOnlyAfterValidation() {
        StorageLayout layout = new StorageLayout(directory.resolve("fresh"));
        assertEquals(StorageVerdict.FIRST_INSTALL, guard.verdict(layout, true));
        guard.requireStartable(layout, true);
        assertTrue(Files.isDirectory(layout.dataDir()));
        assertFalse(Files.exists(layout.databaseFile()));
    }

    @Test
    void h2DirectoryIsReady() throws Exception {
        StorageLayout layout = new StorageLayout(directory);
        Files.write(layout.databaseFile(), new byte[]{1});
        assertEquals(StorageVerdict.READY, guard.verdict(layout, true));
    }

    @Test
    void legacyDataAndEveryCompanionRefuseEmptyH2Creation() throws Exception {
        for (String suffix : new String[]{"", "-wal", "-shm", "-journal"}) {
            StorageLayout layout = new StorageLayout(Files.createDirectory(directory.resolve("case" + suffix)));
            Path legacy = layout.legacySqliteFile().resolveSibling("lingxi.sqlite" + suffix);
            Files.writeString(legacy, "old-data");
            assertEquals(StorageVerdict.REJECT_LEGACY_SQLITE_DATA, guard.verdict(layout, true));
            IllegalStateException failure = assertThrows(IllegalStateException.class,
                    () -> guard.requireStartable(layout, true));
            assertTrue(failure.getMessage().contains("Migrate-SqliteToH2.ps1"));
            assertTrue(failure.getMessage().contains("停止"));
            assertFalse(Files.exists(layout.databaseFile()));
            assertEquals("old-data", Files.readString(legacy));
        }
    }

    @Test
    void coexistenceRequiresVerifiedManifestAndMatchingSource() throws Exception {
        StorageLayout layout = new StorageLayout(directory);
        Files.writeString(layout.legacySqliteFile(), "old-data");
        Files.write(layout.databaseFile(), new byte[]{1});
        assertEquals(StorageVerdict.REJECT_AMBIGUOUS_DATA, guard.verdict(layout, true));
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(Files.readAllBytes(layout.legacySqliteFile())));
        String manifest = "{\"verified\":true,\"sourceSha256\":\"" + digest + "\"}";
        Files.writeString(layout.migrationManifest(), manifest);
        assertEquals(StorageVerdict.READY, guard.verdict(layout, true));
        Files.writeString(layout.migrationManifest(), manifest.replace("true", "false"));
        assertEquals(StorageVerdict.REJECT_AMBIGUOUS_DATA, guard.verdict(layout, true));
        Files.writeString(layout.migrationManifest(), manifest);
        Files.writeString(layout.legacySqliteFile(), "changed");
        assertEquals(StorageVerdict.REJECT_AMBIGUOUS_DATA, guard.verdict(layout, true));
        Files.writeString(layout.migrationManifest(), "broken-json");
        assertEquals(StorageVerdict.REJECT_AMBIGUOUS_DATA, guard.verdict(layout, true));
    }

    @Test
    void missingDriverDoesNotCreateDirectory() {
        StorageLayout layout = new StorageLayout(directory.resolve("absent"));
        assertEquals(StorageVerdict.REJECT_MISSING_DRIVER, guard.verdict(layout, false));
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> guard.requireStartable(layout, false));
        assertTrue(failure.getMessage().contains("org.h2.Driver"));
        assertFalse(Files.exists(layout.dataDir()));
    }

    @Test
    void blockedDirectoryFailsWithoutFallback() throws Exception {
        Path file = directory.resolve("blocker");
        Files.writeString(file, "data");
        assertThrows(IllegalStateException.class,
                () -> guard.requireStartable(new StorageLayout(file.resolve("nested")), true));
    }
}
