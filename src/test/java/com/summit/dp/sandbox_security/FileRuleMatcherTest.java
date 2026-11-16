package com.summit.dp.sandbox_security;

import com.summit.dp.sandbox_security.application.FileRuleMatcher;
import com.summit.dp.sandbox_security.application.FileRuleMatcher.Operation;
import com.summit.dp.sandbox_security.application.SecurityRuleService;
import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityCategory;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class FileRuleMatcherTest {

    private final SecurityRuleService rules = mock(SecurityRuleService.class);
    private final FileRuleMatcher matcher = new FileRuleMatcher(rules);
    private final Path protectedDir = Path.of(System.getProperty("user.home"), ".ssh").toAbsolutePath().normalize();

    private void stub(SecurityRule... entries) {
        when(rules.rules(SecurityCategory.FILES)).thenReturn(List.of(entries));
    }

    private SecurityRule deny(String pattern, String preset) {
        return new SecurityRule(pattern, "PATH", SecurityAction.DENY, SecurityAction.DENY, SecurityAction.DENY, null, true, preset);
    }

    @Test
    void deniesTheProtectedDirectoryAndEverySubdirectory() {
        stub(deny(protectedDir.toString(), null));
        assertEquals(SecurityAction.DENY, matcher.evaluate(protectedDir, Operation.READ, null).action());
        assertEquals(SecurityAction.DENY, matcher.evaluate(protectedDir.resolve("id_rsa"), Operation.READ, null).action());
        assertEquals(SecurityAction.DENY,
                matcher.evaluate(protectedDir.resolve("nested/deep/key"), Operation.WRITE, null).action());
    }

    @Test
    void doesNotSwallowSiblingsThatMerelyShareThePathPrefix() {
        stub(deny(protectedDir.toString(), null));
        // /a/.ssh 被禁不等于 /a/.sshx 或 /a/.sshrc 被禁：逐段比较而不是字符串前缀。
        assertNull(matcher.evaluate(Path.of(protectedDir + "x"), Operation.READ, null));
        assertNull(matcher.evaluate(protectedDir.getParent().resolve(".sshrc"), Operation.READ, null));
        assertNull(matcher.evaluate(protectedDir.getParent().resolve("work/key"), Operation.READ, null));
    }

    @Test
    void expandsTheSameVariablesAsTheSaveEntrypoint() {
        stub(deny("%USERPROFILE%/.ssh", null));
        assertEquals(SecurityAction.DENY, matcher.evaluate(protectedDir.resolve("id_ed25519"), Operation.READ, null).action());
    }

    @Test
    void judgesReadsWritesAndDeletesFromTheirOwnColumn() {
        stub(deny(protectedDir.toString(), null));
        for (Operation operation : Operation.values()) {
            assertEquals(SecurityAction.DENY, matcher.evaluate(protectedDir.resolve("key"), operation, null).action(),
                    "operation=" + operation);
        }
    }

    @Test
    void disabledRulesAndAllowRulesNeverBlock() {
        stub(new SecurityRule(protectedDir.toString(), "PATH", SecurityAction.DENY, SecurityAction.DENY,
                SecurityAction.DENY, null, false, null));
        assertNull(matcher.evaluate(protectedDir.resolve("key"), Operation.READ, null));

        stub(new SecurityRule(protectedDir.toString(), "PATH", SecurityAction.ALLOW, SecurityAction.ALLOW,
                SecurityAction.ALLOW, null, true, null));
        assertNull(matcher.evaluate(protectedDir.resolve("key"), Operation.READ, null));
    }

    @Test
    void catchAllAllowIsANoOpAndCatchAllDenyCoversEverything() {
        stub(new SecurityRule("**", "PATH", SecurityAction.ALLOW, SecurityAction.ALLOW,
                SecurityAction.ALLOW, null, true, null));
        assertNull(matcher.evaluate(protectedDir, Operation.READ, null));

        stub(deny("**", null));
        assertEquals(SecurityAction.DENY, matcher.evaluate(protectedDir, Operation.READ, null).action());
    }

    @Test
    void fullAccessSkipsProductPresetsButKeepsCustomDenials() {
        stub(deny(protectedDir.toString(), ".ssh"));
        assertNull(matcher.evaluate(protectedDir.resolve("key"), Operation.READ, AgentPermissionMode.FULL_ACCESS));

        stub(deny(protectedDir.toString(), null));
        assertEquals(SecurityAction.DENY,
                matcher.evaluate(protectedDir.resolve("key"), Operation.READ, AgentPermissionMode.FULL_ACCESS).action());
    }

    @Test
    void denialExplainsTheRuleTheMatchKindAndTheTargetPath() {
        stub(deny(protectedDir.toString(), ".ssh"));
        String message = matcher.evaluate(protectedDir.resolve("id_rsa"), Operation.READ, null)
                .describeFile("~/.ssh/id_rsa");
        assertTrue(message.contains("路径匹配"), message);
        assertTrue(message.contains("预设规则 .ssh"), message);
        assertTrue(message.contains("~/.ssh/id_rsa"), message);
        assertTrue(message.contains("安全规则"), message);
        assertFalse(message.contains("命令被安全规则禁止"), "文件拒绝不得套用命令文案: " + message);
    }

    @Test
    void missingTargetOrOperationIsNotADecision() {
        stub(deny("**", null));
        assertNull(matcher.evaluate(null, Operation.READ, null));
        assertNull(matcher.evaluate(protectedDir, null, null));
    }
}
