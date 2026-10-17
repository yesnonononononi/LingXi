package com.summit.dp.workspace;

import com.summit.dp.workflow.infrastructure.config.SandboxRuntimeLayout;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class SandboxRuntimeLayoutTest {
    @TempDir Path temporary;

    @Test void movingInstallationChangesEveryResolvedComponent() {
        Path first = temporary.resolve("First Install");
        Path moved = temporary.resolve("Moved Install");
        SandboxRuntimeLayout original = SandboxRuntimeLayout.resolve(first);
        SandboxRuntimeLayout layout = SandboxRuntimeLayout.resolve(moved);
        Path runtime = moved.resolve("resources/runtime");
        assertNotEquals(original.nodeExecutable(), layout.nodeExecutable());
        assertEquals(runtime, layout.directory());
        assertEquals(runtime.resolve(layout.windows() ? "node/node.exe" : "node/node"), layout.nodeExecutable());
        assertEquals(runtime.resolve(layout.windows() ? "git/cmd/git.exe" : "git/bin/git"), layout.gitExecutable());
        assertEquals(runtime.resolve(layout.windows() ? "git/bin/bash.exe" : "git/bin/bash"), layout.bashExecutable());
        assertEquals(runtime.resolve("mxc/node_modules/@microsoft/mxc-sdk"), layout.sdkDirectory());
    }

    @Test void checkoutLayoutDoesNotDependOnPreparedRuntimeExisting() throws Exception {
        Path checkout = temporary.resolve("Moved Checkout");
        Files.createDirectories(checkout.resolve("frontend"));
        Files.writeString(checkout.resolve("frontend/package.json"), "{}");
        SandboxRuntimeLayout layout = SandboxRuntimeLayout.resolve(checkout);
        assertEquals(checkout.resolve("frontend/build/runtime"), layout.directory());
        assertFalse(Files.exists(layout.directory()));
    }

    @Test void windowsCommandPathContainsBundledNodeGitAndBashAndHonorsExplicitPath() {
        Path runtime = temporary.resolve("runtime");
        SandboxRuntimeLayout layout = new SandboxRuntimeLayout(runtime, true);
        String configured = layout.commandEnvironment(Map.of("LANG", "C.UTF-8")).get("PATH");
        String[] directories = configured.split(";");
        assertEquals(runtime.resolve("node").toString(), directories[0]);
        assertEquals(runtime.resolve("git/cmd").toString(), directories[1]);
        assertEquals(runtime.resolve("git/bin").toString(), directories[2]);
        assertEquals("C.UTF-8", layout.commandEnvironment(Map.of("LANG", "C.UTF-8")).get("LANG"));
        assertEquals(Map.of("Path", "custom"), layout.commandEnvironment(Map.of("Path", "custom")));
    }

    @Test void linuxCommandPathKeepsSystemCommandsAlongsideBundledTools() {
        Path runtime = temporary.resolve("runtime");
        SandboxRuntimeLayout layout = new SandboxRuntimeLayout(runtime, false);
        assertEquals(runtime.resolve("node/node"), layout.nodeExecutable());
        assertEquals(runtime.resolve("node") + ":" + runtime.resolve("git/bin") + ":/usr/bin:/bin",
                layout.commandEnvironment(Map.of()).get("PATH"));
    }
}
