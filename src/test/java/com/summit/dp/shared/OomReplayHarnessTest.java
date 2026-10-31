package com.summit.dp.shared;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.tools.JavaCompiler;
import javax.tools.ToolProvider;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 防止重放器自己保留每轮历史，制造生产实现不存在的内存泄漏。 */
class OomReplayHarnessTest {

    @TempDir
    static Path classes;

    @TempDir
    Path checkpoints;

    @BeforeAll
    static void compileReplay() {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        assertNotNull(compiler, "重放工具需要 JDK 编译器");
        assertEquals(0, compiler.run(null, null, null, "-encoding", "UTF-8", "-d", classes.toString(),
                Path.of("tools/oom/CheckpointReplay.java").toAbsolutePath().toString()));
    }

    @Test
    void varcharReplayKeepsOneCommittedCheckpointPerExecution() throws Exception {
        assertEquals(2, replay("varchar"), "两份执行各保存五轮，缓存只能保留两份最新版");
    }

    @Test
    void fileReplayDoesNotCacheCheckpointBodies() throws Exception {
        assertEquals(0, replay("file"), "文件检查点路径不应保留正文缓存");
        assertEquals("checkpoint", Files.readString(checkpoints.resolve("101/ck-5.json")));
    }

    private int replay(String mode) throws Exception {
        // 这里只验证重放器的保留行为，数据库往返由现有 H2 用例负责。
        Connection connection = mock(Connection.class);
        PreparedStatement statement = mock(PreparedStatement.class);
        when(connection.prepareStatement(anyString())).thenReturn(statement);
        when(statement.executeUpdate()).thenReturn(1);
        try (URLClassLoader loader = new URLClassLoader(new URL[]{classes.toUri().toURL()},
                ClassLoader.getPlatformClassLoader())) {
            Class<?> replay = loader.loadClass("CheckpointReplay");
            Class<?> fixtures = loader.loadClass("CheckpointReplay$Fixtures");
            Constructor<?> constructor = fixtures.getDeclaredConstructor(String.class, String.class,
                    long.class, Path.class);
            constructor.setAccessible(true);
            Object input = constructor.newInstance("checkpoint", "context", 10L, checkpoints);
            Method run = replay.getDeclaredMethod("run", Connection.class, fixtures, List.class,
                    String.class, String.class, int.class, long.class, int.class);
            run.setAccessible(true);
            int retained = (Integer) run.invoke(null, connection, input, List.of(101L, 102L), mode,
                    "pre", 5, 0L, 0);
            verify(statement, times(10)).executeUpdate();
            return retained;
        }
    }
}
