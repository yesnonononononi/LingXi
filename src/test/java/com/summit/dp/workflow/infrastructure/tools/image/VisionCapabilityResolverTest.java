package com.summit.dp.workflow.infrastructure.tools.image;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class VisionCapabilityResolverTest {
    @Test
    void onlyAsteriskIsSpecialAndNamesAreCaseInsensitive() {
        VisionCapabilityResolver resolver = new VisionCapabilityResolver(" gpt-4o*, my.model+[v1] ");
        assertTrue(resolver.supports(" GPT-4O-2024-08-06 "));
        assertTrue(resolver.supports("my.model+[v1]"));
        assertFalse(resolver.supports("myXmodellv1"));
        assertFalse(resolver.supports("deepseek-flash"));
        assertFalse(resolver.supports(null));
        assertFalse(new VisionCapabilityResolver("").supports("gpt-4o"));
    }
}
