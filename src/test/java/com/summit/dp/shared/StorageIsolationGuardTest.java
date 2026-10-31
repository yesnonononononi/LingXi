package com.summit.dp.shared;

import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.StorageIsolationGuard;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 隔离守卫（设计 §附录D.3 / T05 完成判据 1 与 3 与 4）。
 *
 * <p>三件事必须被钉住：① 两个禁区目录被明确拒绝；② H2 用例跑的是<b>真实文件库</b>
 * （系统临时目录下的 {@code .mv.db} 文件，不是内存库）；③ 用例结束后临时目录被清理干净。</p>
 */
class StorageIsolationGuardTest {

    @Test
    @DisplayName("禁区路径被拒绝：~/.lingxi/data 与 <仓库>/.lingxi/development/data（含其父目录）")
    void forbiddenPathsAreRejected() {
        Path userData = StorageIsolationGuard.userDataDir();
        Path developmentData = StorageIsolationGuard.developmentDataDir();
        assertTrue(StorageIsolationGuard.isForbidden(userData),
                "安装版数据目录必须命中禁区: " + userData);
        assertTrue(StorageIsolationGuard.isForbidden(userData.resolve("lingxi.sqlite")),
                "禁区内的文件同样必须命中: " + userData.resolve("lingxi.sqlite"));
        assertTrue(StorageIsolationGuard.isForbidden(developmentData),
                "工作区开发数据目录必须命中禁区: " + developmentData);
        assertTrue(StorageIsolationGuard.isForbidden(developmentData.resolve("lingxi-h2.mv.db")),
                "禁区内的 H2 库文件同样必须命中");
        assertTrue(StorageIsolationGuard.isForbidden(userData.getParent()),
                "禁区的父目录也必须拒绝（否则可以往上一层绕过）");

        assertThrows(IllegalArgumentException.class, () -> StorageIsolationGuard.require(userData),
                "命中禁区必须抛错，不能用「跳过」代替失败");
        assertThrows(IllegalArgumentException.class, () -> StorageIsolationGuard.require(developmentData),
                "命中禁区必须抛错");

        Path temp = Path.of(System.getProperty("java.io.tmpdir"), "lingxi-h2-verify", "probe");
        assertFalse(StorageIsolationGuard.isForbidden(temp), "系统临时目录下的路径必须被允许: " + temp);
    }

    @Test
    @DisplayName("H2 用例跑在真实文件库：库文件是临时目录下的 .mv.db，且用例结束不留目录")
    void h2TestsUseRealFileDatabaseInTempDirectory() {
        Path tempRoot = Path.of(System.getProperty("java.io.tmpdir")).toAbsolutePath().normalize();
        H2TestDatabase database = H2TestDatabase.create("isolation-probe");
        Path directory = database.directory();
        Path databaseFile = database.databaseFile();
        try {
            assertTrue(directory.startsWith(tempRoot),
                    "H2 测试库目录必须在系统临时目录下，实际=" + directory);
            assertTrue(Files.isRegularFile(databaseFile),
                    "H2 测试库必须是真实文件（内存库不会落 .mv.db），实际=" + databaseFile);
            assertTrue(databaseFile.getFileName().toString().endsWith(".mv.db"),
                    "库文件名必须是 .mv.db，实际=" + databaseFile.getFileName());
            assertFalse(StorageIsolationGuard.isForbidden(directory), "测试库目录不得落在禁区");
            // 真实文件库才能谈「关闭重开」：schema_version 必须在磁盘上读得到。
            assertTrue(database.queryString("SELECT COUNT(*) FROM schema_version") != null,
                    "真实文件库必须能查询版本表");
        } finally {
            database.shutdown();
        }
        assertFalse(Files.exists(directory),
                "用例结束必须递归删除临时目录（工作区无残留的前提），实际仍存在=" + directory);
    }

    @Test
    @DisplayName("测试源码里没有内存库连接串（jdbc:h2:mem 前缀），避免用内存库冒充文件库")
    void testSourcesContainNoInMemoryDatabase() throws IOException {
        Path root = locateTestSources();
        // 拼出来再比：本文件自身也不该出现可被扫到的字面量。
        String needle = "jdbc:h2:" + "mem:";
        List<String> offenders = new ArrayList<>();
        try (Stream<Path> files = Files.walk(root)) {
            for (Path file : files.filter(path -> path.toString().endsWith(".java")).toList()) {
                String body = stripComments(Files.readString(file, StandardCharsets.UTF_8));
                if (body.contains(needle)) {
                    offenders.add(root.relativize(file).toString().replace('\\', '/'));
                }
            }
        }
        assertTrue(offenders.isEmpty(), "禁止用内存库冒充文件库，命中=" + offenders);
    }

    /** 去掉注释：注释里提到连接串是说明文字，不是「用内存库」的证据。 */
    private static String stripComments(String body) {
        String withoutBlock = body.replaceAll("(?s)/\\*.*?\\*/", " ");
        return withoutBlock.replaceAll("(?m)//.*$", " ");
    }

    private static Path locateTestSources() {
        Path dir = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        for (int hops = 0; hops < 4 && dir != null; hops++, dir = dir.getParent()) {
            Path candidate = dir.resolve("src/test/java");
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
        }
        return Paths.get("src/test/java").toAbsolutePath();
    }
}
