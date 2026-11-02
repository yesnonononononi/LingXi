package com.summit.dp.model;

import com.summit.harness.springbootautoconfigure.properties.CompactContextModelProperties;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.bind.PropertySourcesPlaceholdersResolver;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.MutablePropertySources;
import org.springframework.core.env.PropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * 压缩档的 yaml 键必须真的绑到框架属性上。
 *
 * <p>压缩语义由框架按 {@code lingxi.agent.model.conf.compact} 前缀读取，业务 yaml 只负责给值；
 * 一旦键名写错或层级错位，摘要会静默落回框架缺省 —— 页面还显示 32768，实际压缩档全是默认，
 * 这类「配置看着在、其实没生效」的漂移没有任何运行期报错，只能靠本类拦截。</p>
 */
class CompactModelConfigBindingTest {

    @Test
    void applicationYamlDrivesTheCompactProfileTheFrameworkConsumes() throws IOException {
        List<PropertySource<?>> sources = new YamlPropertySourceLoader()
                .load("application", new ClassPathResource("application.yaml"));
        MutablePropertySources propertySources = new MutablePropertySources();
        sources.forEach(propertySources::addLast);

        CompactContextModelProperties compact = new Binder(
                ConfigurationPropertySources.from(propertySources),
                new PropertySourcesPlaceholdersResolver(new StandardEnvironment()))
                .bind("lingxi.agent.model.conf.compact", Bindable.of(CompactContextModelProperties.class))
                .orElseThrow(() -> new AssertionError("yaml 缺少 lingxi.agent.model.conf.compact 段"));

        // 默认省略 effort，避免兼容接口拒绝 none/off。
        assertNull(compact.getReasoningEffort());
        assertEquals("disabled", compact.getThinkingType());
        assertFalse(compact.isReturnThinking());
        assertFalse(compact.isSendThinking());
        assertEquals(32768, compact.getMaxTokens());
    }
}
