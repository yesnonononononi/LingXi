package com.summit.dp.user_configs;

import com.summit.dp.user_configs.infrastructure.config.UserConfigDataDirPostProcessor;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.mock.env.MockEnvironment;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
    @DisplayName("注册有效：spring.factories 里读得到（键名/类名/文件位置任一处写错都会静默失效）")
    void registeredForSpringBootStartup() throws IOException {
        // 这段守的是「注册到底生效了没有」：解析逻辑本身单测全绿也没用，
        // 只要 spring.factories 的路径、键名或类名写错，Spring 启动期就找不到这个扩展点，
        // 设置页里的数据目录压根不会被采用 —— 而且不会报错，只会「改了没反应」。
        Properties factories = new Properties();
        try (InputStream stream = getClass().getClassLoader()
                .getResourceAsStream("META-INF/spring.factories")) {
            assertNotNull(stream, "META-INF/spring.factories 必须在 classpath 上（Spring 就是按这个路径找的）");
            factories.load(stream);
        }

        String registeredValue = factories.getProperty(EnvironmentPostProcessor.class.getName());
        assertNotNull(registeredValue, "必须按 EnvironmentPostProcessor 这个键注册，换键 Spring 不会认");
        // 必须逐个精确比对：用 contains 会被「正确类名 + 多余后缀」蒙混过关（PostProcessorXX 里也含 PostProcessor）。
        List<String> registered = Arrays.stream(registeredValue.split(","))
                .map(String::trim)
                .filter(name -> !name.isEmpty())
                .toList();
        assertTrue(registered.contains(UserConfigDataDirPostProcessor.class.getName()),
                "注册名单里必须精确包含数据目录解析器，实际内容: " + registered);
    }

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
