package com.summit.dp.user_configs;

import com.summit.dp.user_configs.infrastructure.config.UserConfigDataDirPostProcessor;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.SpringApplication;
import org.springframework.mock.env.MockEnvironment;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 启动期数据目录的解析优先级。
 *
 * <p>库位置写在 {@code spring.datasource.url} 里，容器装配数据源时就定死了 —— 这一层解析错了，
 * 用户改的数据目录根本不会被用上，而且现象是「启动后数据全没了」，很难往配置优先级上想。</p>
 */
class UserConfigDataDirPostProcessorTest {

    @TempDir
    Path tempDir;

    private final UserConfigDataDirPostProcessor postProcessor = new UserConfigDataDirPostProcessor();

    @Test
    @DisplayName("设置行写了 dataDir：覆盖 yaml 的 lingxi.data.dir")
    void dataDirFromSettingsRowOverridesConfiguredOne() throws IOException {
        Path custom = tempDir.resolve("custom-data");
        MockEnvironment environment = environmentWithSettingsRow(custom);

        postProcessor.postProcessEnvironment(environment, new SpringApplication(Object.class));

        assertEquals(custom.toString(), environment.getProperty("lingxi.data.dir"));
    }

    @Test
    @DisplayName("配置文件不存在：保持 yaml 的值，不报错")
    void missingConfigFileKeepsConfiguredDataDir() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("lingxi.config.user-configs.path", tempDir.resolve("absent.json").toString());
        environment.setProperty("lingxi.data.dir", tempDir.resolve("default-data").toString());

        postProcessor.postProcessEnvironment(environment, new SpringApplication(Object.class));

        assertEquals(tempDir.resolve("default-data").toString(), environment.getProperty("lingxi.data.dir"));
    }

    @Test
    @DisplayName("设置行没写 dataDir：保持 yaml 的值")
    void settingsRowWithoutDataDirKeepsConfiguredOne() throws IOException {
        Path configPath = tempDir.resolve("user-configs.json");
        Files.writeString(configPath, "[ { \"id\": 1, \"renderTheme\": \"LIGHT\" } ]");
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("lingxi.config.user-configs.path", configPath.toString());
        environment.setProperty("lingxi.data.dir", tempDir.resolve("default-data").toString());

        postProcessor.postProcessEnvironment(environment, new SpringApplication(Object.class));

        assertEquals(tempDir.resolve("default-data").toString(), environment.getProperty("lingxi.data.dir"));
    }

    @Test
    @DisplayName("配置文件读坏了：回落 yaml 而不是让应用起不来")
    void brokenConfigFileFallsBackToConfiguredValue() throws IOException {
        Path configPath = tempDir.resolve("user-configs.json");
        Files.writeString(configPath, "{ 这不是数组 }");
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("lingxi.config.user-configs.path", configPath.toString());
        environment.setProperty("lingxi.data.dir", tempDir.resolve("default-data").toString());

        postProcessor.postProcessEnvironment(environment, new SpringApplication(Object.class));

        assertEquals(tempDir.resolve("default-data").toString(), environment.getProperty("lingxi.data.dir"));
    }

    private MockEnvironment environmentWithSettingsRow(Path dataDir) throws IOException {
        Path configPath = tempDir.resolve("user-configs.json");
        // Windows 路径含反斜杠，写进 JSON 前必须转义，否则读到的是控制字符。
        String jsonPath = dataDir.toString().replace("\\", "\\\\");
        Files.writeString(configPath, "[ { \"id\": 1, \"dataDir\": \"" + jsonPath + "\" } ]");
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("lingxi.config.user-configs.path", configPath.toString());
        environment.setProperty("lingxi.data.dir", tempDir.resolve("default-data").toString());
        return environment;
    }

    @Test
    @DisplayName("设置行里是非法路径：忽略它并回落 yaml，启动不能因此失败")
    void illegalDataDirInSettingsRowIsIgnored() throws IOException {
        Path configPath = tempDir.resolve("user-configs.json");
        // Windows 下 '<' 是非法路径字符：Path.of 会抛 InvalidPathException，
        // 若不在这一层吞掉，EnvironmentPostProcessor 失败会直接让应用起不来。
        Files.writeString(configPath, "[ { \"id\": 1, \"dataDir\": \"D:/bad<dir>/data\" } ]");
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("lingxi.config.user-configs.path", configPath.toString());
        environment.setProperty("lingxi.data.dir", tempDir.resolve("default-data").toString());

        postProcessor.postProcessEnvironment(environment, new SpringApplication(Object.class));

        assertEquals(tempDir.resolve("default-data").toString(), environment.getProperty("lingxi.data.dir"));
    }
}
