package com.summit.dp.shared.config;

import com.summit.dp.shared.storage.H2ShutdownCompactor;
import com.summit.dp.shared.storage.StorageLayout;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Arrays;

/** 装配 H2 停机压缩钩子与启动期碎片巡检，保证停机压缩严格发生在连接池关闭之后。 */
@Slf4j
@Configuration
public class H2MaintenanceConfig {

    private static final String COMPACTOR_BEAN_NAME = "h2ShutdownCompactor";
    private static final long BYTES_PER_MB = 1024L * 1024L;

    @Bean(name = COMPACTOR_BEAN_NAME)
    public H2ShutdownCompactor h2ShutdownCompactor(
            @Value("${lingxi.data.dir:${user.home}/.lingxi/data}") String dataDir,
            @Value("${spring.datasource.username:}") String username,
            @Value("${spring.datasource.password:}") String password,
            @Value("${lingxi.storage.h2-compact-on-shutdown.enabled:true}") boolean enabled,
            @Value("${lingxi.storage.h2-compact-on-shutdown.min-file-size-mb:256}") long minFileSizeMb,
            @Value("${lingxi.storage.h2-compact-on-shutdown.max-fill-rate-percent:50}") int maxFillRatePercent) {
        return new H2ShutdownCompactor(
                new StorageLayout(Path.of(dataDir)),
                username,
                password,
                enabled,
                minFileSizeMb,
                maxFillRatePercent);
    }

    /** 让所有 DataSource Bean 显式依赖停机压缩器，使容器销毁时先关连接池再执行压缩。 */
    @Bean
    public static BeanFactoryPostProcessor h2DataSourceDependsOnCompactor() {
        return new BeanFactoryPostProcessor() {
            @Override
            public void postProcessBeanFactory(ConfigurableListableBeanFactory beanFactory) throws BeansException {
                if (!beanFactory.containsBeanDefinition(COMPACTOR_BEAN_NAME)) {
                    return;
                }
                String[] dataSourceNames = beanFactory.getBeanNamesForType(DataSource.class, true, false);
                for (String beanName : dataSourceNames) {
                    BeanDefinition definition = beanFactory.getBeanDefinition(beanName);
                    String[] existing = definition.getDependsOn();
                    if (existing == null || existing.length == 0) {
                        definition.setDependsOn(COMPACTOR_BEAN_NAME);
                    } else if (!Arrays.asList(existing).contains(COMPACTOR_BEAN_NAME)) {
                        String[] updated = Arrays.copyOf(existing, existing.length + 1);
                        updated[existing.length] = COMPACTOR_BEAN_NAME;
                        definition.setDependsOn(updated);
                    }
                }
            }
        };
    }

    /** 启动完成后抽样检查一次 H2 填充率，强杀未走停机压缩时可尽早通过日志发现。 */
    @Bean
    public ApplicationListener<ApplicationReadyEvent> h2StartupHealthInspector(
            DataSource dataSource,
            @Value("${lingxi.storage.h2-compact-on-shutdown.min-file-size-mb:256}") long minFileSizeMb,
            @Value("${lingxi.storage.h2-compact-on-shutdown.max-fill-rate-percent:50}") int maxFillRatePercent) {
        return event -> {
            long minBytes = Math.max(0L, minFileSizeMb) * BYTES_PER_MB;
            try (Connection conn = dataSource.getConnection();
                 Statement st = conn.createStatement();
                 ResultSet rs = st.executeQuery(
                         "SELECT SETTING_NAME, SETTING_VALUE FROM INFORMATION_SCHEMA.SETTINGS "
                                 + "WHERE SETTING_NAME IN ('info.FILE_SIZE', 'info.CHUNKS_FILL_RATE', 'info.CHUNK_COUNT')")) {
                long fileSize = 0L;
                long fillRate = 100L;
                long chunkCount = 0L;
                while (rs.next()) {
                    String name = rs.getString(1);
                    String value = rs.getString(2);
                    if (value == null) {
                        continue;
                    }
                    long parsed = Long.parseLong(value.trim());
                    if ("info.FILE_SIZE".equals(name)) {
                        fileSize = parsed;
                    } else if ("info.CHUNKS_FILL_RATE".equals(name)) {
                        fillRate = parsed;
                    } else if ("info.CHUNK_COUNT".equals(name)) {
                        chunkCount = parsed;
                    }
                }
                if (fileSize >= minBytes && fillRate <= maxFillRatePercent) {
                    log.warn("H2 数据库空间碎片严重，建议正常停机触发自动压缩或执行 compact-h2.ps1: "
                            + "sizeMB={}, fillRate={}%, chunkCount={}",
                            fileSize / BYTES_PER_MB, fillRate, chunkCount);
                }
            } catch (Exception failure) {
                log.debug("跳过 H2 启动期碎片巡检: reason={}", failure.getMessage());
            }
        };
    }
}
