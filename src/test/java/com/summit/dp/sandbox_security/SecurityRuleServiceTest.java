package com.summit.dp.sandbox_security;

import com.summit.core.runtime.security.SecurityAction;
import com.summit.dp.sandbox_security.application.SecurityRulePresets;
import com.summit.dp.sandbox_security.application.SecurityRuleService;
import com.summit.dp.sandbox_security.application.SecurityRuleService.SaveRules;
import com.summit.dp.sandbox_security.application.SecurityRuleService.SecurityRuleView;
import com.summit.dp.sandbox_security.domain.model.SecurityCategory;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import com.summit.dp.sandbox_security.infrastructure.repository.JsonSecurityRuleRepository;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import static org.junit.jupiter.api.Assertions.*;

class SecurityRuleServiceTest {
    @TempDir Path directory;
    private JsonSecurityRuleRepository repository(String suffix, SecurityCategory category) {
        return new JsonSecurityRuleRepository(directory.resolve("sandbox-security-rule-" + suffix + ".json"),
                () -> SecurityRulePresets.defaults(category));
    }
    private SecurityRuleService service() {
        return new SecurityRuleService(repository("files", SecurityCategory.FILES),
                repository("terminal", SecurityCategory.TERMINAL), repository("net", SecurityCategory.NET));
    }
    private SecurityRule file(String path, SecurityAction action) {
        return new SecurityRule(path, "PATH", action, action, action, null, true, null);
    }
    @Test void seedsThreeSeparateTablesAndRoundTripsCustomRules() throws Exception {
        SecurityRuleService service = service();
        assertEquals(8, service.current("files").rules().size());
        assertEquals("CONFIGURATION_ONLY", service.current("files").activation());
        assertEquals(6, service.current("terminal").rules().size());
        assertEquals(SecurityAction.ALLOW, service.current("net").rules().getFirst().action());
        SecurityRule custom = file(directory.resolve("中文隐私").toString(), SecurityAction.DENY);
        SecurityRuleView saved = service.save("files", new SaveRules(0, List.of(custom)));
        assertEquals(1, saved.revision());
        assertEquals(List.of(custom), service().current("files").rules());
        assertEquals(6, service().current("terminal").rules().size());
        assertTrue(Files.readString(directory.resolve("sandbox-security-rule-files.json")).contains("中文隐私"));
    }
    @Test void staleRevisionCannotOverwriteAnotherWindow() {
        SecurityRuleService service = service();
        service.save("files", new SaveRules(0, List.of(file(directory.toString(), SecurityAction.DENY))));
        assertThrows(ClientException.class, () -> service.save("files", new SaveRules(0, List.of())));
        assertEquals(1, service.current("files").rules().size());
        assertEquals(1, service.current("files").revision());
    }
    @Test void rejectsUnsupportedApprovalAndNetworkFilteringWithoutWriting() {
        SecurityRuleService service = service();
        assertThrows(ClientException.class, () -> service.save("files", new SaveRules(0, List.of(file(directory.toString(), SecurityAction.ASK)))));
        SecurityRule denyNet = new SecurityRule("**", "ANY", null, null, null, SecurityAction.DENY, true, null);
        assertThrows(ClientException.class, () -> service.save("net", new SaveRules(0, List.of(denyNet))));
        assertThrows(ClientException.class, () -> service.save("net", new SaveRules(0, List.of())));
        assertEquals(0, service.current("files").revision());
        assertEquals(SecurityAction.ALLOW, service.current("net").rules().getFirst().action());
        assertEquals(0, service.current("net").revision());
    }
    @Test void validatesPathsCategoriesAndDuplicateRules() {
        SecurityRuleService service = service();
        assertThrows(ClientException.class, () -> service.current("unknown"));
        assertThrows(ClientException.class, () -> service.save("files", new SaveRules(0, List.of(file("relative", SecurityAction.DENY)))));
        assertThrows(ClientException.class, () -> service.save("files", new SaveRules(0, List.of(file("%UNKNOWN%/file", SecurityAction.DENY)))));
        SecurityRule valid = file(directory.toString(), SecurityAction.DENY);
        assertThrows(ClientException.class, () -> service.save("files", new SaveRules(0, List.of(valid, valid))));
        assertEquals(0, service.current("files").revision());
    }
    @Test void explicitCatchAllIsSupportedWithoutInventingAWorkspaceBoundary() {
        SecurityRuleService service = service();
        SecurityRule catchAll = file("**", SecurityAction.ALLOW);
        assertEquals(List.of(catchAll), service.save("files", new SaveRules(0, List.of(catchAll))).rules());
    }
    @Test void defaultsAreADraftAndDoNotOverwriteSavedRules() {
        SecurityRuleService service = service();
        service.save("files", new SaveRules(0, List.of()));
        assertEquals(8, service.defaults("files").size());
        assertTrue(service.current("files").rules().isEmpty());
        assertEquals(1, service.current("files").revision());
    }
    @Test void concurrentRepositoryInstancesOnlyAcceptOneRevision() throws Exception {
        SecurityRuleService first = service();
        SecurityRuleService second = service();
        first.current("files");
        CountDownLatch start = new CountDownLatch(1);
        Callable<Boolean> saveFirst = () -> { start.await(); try { first.save("files", new SaveRules(0, List.of())); return true; } catch (ClientException stale) { return false; } };
        Callable<Boolean> saveSecond = () -> { start.await(); try { second.save("files", new SaveRules(0, List.of(file(directory.toString(), SecurityAction.DENY)))); return true; } catch (ClientException stale) { return false; } };
        try (ExecutorService executor = Executors.newFixedThreadPool(2)) {
            Future<Boolean> one = executor.submit(saveFirst);
            Future<Boolean> two = executor.submit(saveSecond);
            start.countDown();
            assertNotEquals(one.get(), two.get());
        }
        assertEquals(1, service().current("files").revision());
    }
}
