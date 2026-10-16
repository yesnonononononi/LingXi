package com.summit.dp.sandbox_security.infrastructure;

import com.summit.dp.sandbox_security.application.SecurityRulePresets;
import com.summit.dp.sandbox_security.domain.model.SecurityCategory;
import com.summit.dp.sandbox_security.domain.repository.SecurityRuleRepository;
import com.summit.dp.sandbox_security.infrastructure.repository.JsonSecurityRuleRepository;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import java.nio.file.Path;

@Configuration(proxyBeanMethods = false)
public class SecurityRuleConfiguration {
    @Bean("securityFilesRepository") public SecurityRuleRepository files(
            @Value("${lingxi.config.sandbox-security.directory:${user.home}/.lingxi/config}") String directory) {
        return repository(directory, "files", SecurityCategory.FILES);
    }
    @Bean("securityTerminalRepository") public SecurityRuleRepository terminal(
            @Value("${lingxi.config.sandbox-security.directory:${user.home}/.lingxi/config}") String directory) {
        return repository(directory, "terminal", SecurityCategory.TERMINAL);
    }
    @Bean("securityNetRepository") public SecurityRuleRepository net(
            @Value("${lingxi.config.sandbox-security.directory:${user.home}/.lingxi/config}") String directory) {
        return repository(directory, "net", SecurityCategory.NET);
    }
    private SecurityRuleRepository repository(String directory, String suffix, SecurityCategory category) {
        return new JsonSecurityRuleRepository(Path.of(directory).resolve("sandbox-security-rule-" + suffix + ".json"),
                () -> SecurityRulePresets.defaults(category));
    }
}
