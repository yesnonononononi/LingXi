package com.summit.dp.sandbox_security.application;

import com.summit.core.runtime.security.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityCategory;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import java.util.ArrayList;
import java.util.List;

/** 隐私目录预设属于产品，不下沉到通用框架。 */
public final class SecurityRulePresets {
    private SecurityRulePresets() { }
    public static List<SecurityRule> defaults(SecurityCategory category) {
        List<SecurityRule> result = new ArrayList<>();
        switch (category) {
            case FILES -> {
                for (String name : List.of(".ssh", ".aws", ".gcp", ".gnupg", ".azure", ".config/gcloud", ".netrc", ".git-credentials")) {
                    result.add(new SecurityRule("%USERPROFILE%/" + name, "PATH", SecurityAction.DENY,
                            SecurityAction.DENY, SecurityAction.DENY, null, true, name));
                }
            }
            case TERMINAL -> {
                for (String program : List.of("wsl", "wslconfig", "wmic", "sc", "reg", "schtasks")) {
                    result.add(new SecurityRule(program, "PROGRAM", null, null, null,
                            SecurityAction.DENY, true, program));
                }
            }
            case NET -> result.add(new SecurityRule("**", "ANY", null, null, null,
                    SecurityAction.ALLOW, true, "default-allow"));
        }
        return List.copyOf(result);
    }
}
