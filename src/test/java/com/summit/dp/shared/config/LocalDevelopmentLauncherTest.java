package com.summit.dp.shared.config;

import com.summit.dp.LingXiApplication;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.MockedConstruction;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.logging.LoggingApplicationListener;
import org.springframework.boot.system.ApplicationHome;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mockConstruction;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class LocalDevelopmentLauncherTest {
    @TempDir
    Path temporary;

    @Test
    void sourceEntryPointActivatesLocalIsolation() {
        try (MockedConstruction<SpringApplication> applications = mockConstruction(SpringApplication.class);
             MockedConstruction<ApplicationHome> homes = mockConstruction(ApplicationHome.class,
                     (home, construction) -> when(home.getSource()).thenReturn(temporary.toFile()))) {
            LingXiApplication.main(new String[0]);
            verify(applications.constructed().getFirst()).setAdditionalProfiles("dev", "local");
        }
    }

    @Test
    void sourceStartupUsesIsolatedDataAndConfigEvenWhenInstalledSettingsPointElsewhere() throws Exception {
        Path installedConfig = temporary.resolve("home/.lingxi/config");
        Files.createDirectories(installedConfig);
        Files.writeString(installedConfig.resolve("user-configs.json"),
                "[{\"id\":1,\"dataDir\":\"installed-data-must-not-be-used\"}]");
        SpringApplication application = new SpringApplication(EmptyConfiguration.class);
        application.setListeners(application.getListeners().stream()
                .filter(listener -> !(listener instanceof LoggingApplicationListener)).toList());
        LocalDevelopmentLauncher.configure(application, Files.createDirectory(temporary.resolve("classes")).toFile());

        try (ConfigurableApplicationContext context = application.run(
                "--user.dir=" + temporary.resolve("checkout"), "--user.home=" + temporary.resolve("home"),
                "--spring.main.web-application-type=none", "--spring.main.banner-mode=off")) {
            Environment environment = context.getEnvironment();
            String root = temporary.resolve("checkout") + "/.lingxi/development";
            assertEquals(root + "/data", environment.getProperty("lingxi.data.dir"));
            assertEquals(root + "/skill", environment.getProperty("lingxi.skill.dir"));
            assertEquals(root + "/sandbox", environment.getProperty("lingxi.sandbox.state-directory"));
            assertEquals(root + "/logs", environment.getProperty("lingxi.log.dir"));
            assertEquals("8089", environment.getProperty("server.port"));
            for (String key : new String[]{"user-configs", "mcp", "model", "provider", "personalization"}) {
                assertTrue(environment.getProperty("lingxi.config." + key + ".path").startsWith(root + "/config/"));
            }
            assertEquals(root + "/config", environment.getProperty("lingxi.config.sandbox-security.directory"));
        }
    }

    @Test
    void packagedStartupKeepsInstalledPortAndDirectories() throws Exception {
        SpringApplication application = new SpringApplication(EmptyConfiguration.class);
        application.setListeners(application.getListeners().stream()
                .filter(listener -> !(listener instanceof LoggingApplicationListener)).toList());
        LocalDevelopmentLauncher.configure(application, Files.createFile(temporary.resolve("app.jar")).toFile());

        try (ConfigurableApplicationContext context = application.run(
                "--user.home=" + temporary.resolve("packaged-home"),
                "--spring.main.web-application-type=none", "--spring.main.banner-mode=off")) {
            assertEquals("8088", context.getEnvironment().getProperty("server.port"));
            assertEquals(temporary.resolve("packaged-home") + "/.lingxi/data",
                    context.getEnvironment().getProperty("lingxi.data.dir"));
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class EmptyConfiguration {
    }
}
