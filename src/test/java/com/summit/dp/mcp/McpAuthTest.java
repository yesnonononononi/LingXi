package com.summit.dp.mcp;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.mcp.domain.model.McpAuth;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 认证方式的取值护栏：非法输入必须当场拒绝，而不是落库后连不上。 */
class McpAuthTest {

    @Test
    void missingModeFallsBackToNone() {
        // 历史数据没有这个字段，缺失必须等价于「没配置认证」，否则老服务会莫名要求登录
        assertFalse(new McpAuth(null, null, null, null).isOauth());
        assertFalse(new McpAuth("  ", null, List.of(), null).isOauth());
        assertEquals(McpAuth.MODE_NONE, McpAuth.NONE.mode());
    }

    @Test
    void oauthModeIsRecognizedCaseInsensitively() {
        assertTrue(new McpAuth(" OAUTH ", null, List.of(), null).isOauth());
    }

    @Test
    void unknownModeIsRejected() {
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> new McpAuth("basic", null, null, null));
        assertEquals("认证方式仅支持 none / oauth", failure.getMessage());
    }

    @Test
    void clientIdMustNotCarryWhitespace() {
        assertThrows(IllegalArgumentException.class, () -> new McpAuth("oauth", "a b", null, null));
    }

    @Test
    void authorizationServerMustBeHttpUrl() {
        assertThrows(IllegalArgumentException.class, () -> new McpAuth("oauth", null, null, "ftp://auth.test"));
        assertThrows(IllegalArgumentException.class, () -> new McpAuth("oauth", null, null, "auth.test"));
        assertEquals("https://auth.test", new McpAuth("oauth", null, null, " https://auth.test ").authorizationServer());
    }

    @Test
    void scopesAreTrimmedAndDeduplicated() {
        McpAuth auth = new McpAuth("oauth", null, List.of(" mcp:read ", "mcp:read", "", "mcp:write"), null);
        assertEquals(List.of("mcp:read", "mcp:write"), auth.scopes());
    }

    @Test
    void blankOptionalFieldsBecomeNull() {
        McpAuth auth = new McpAuth("oauth", "   ", null, "  ");
        assertNull(auth.clientId());
        assertNull(auth.authorizationServer());
        assertEquals(List.of(), auth.scopes());
    }

    @Test
    void jacksonRoundTripOmitsDerivedOauthFlagAndAcceptsLegacyJson() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        McpAuth original = new McpAuth(McpAuth.MODE_OAUTH, null, List.of(), null);
        String json = mapper.writeValueAsString(original);
        assertFalse(json.contains("\"oauth\":"), "序列化不应输出派生属性 oauth: " + json);
        assertEquals(original, mapper.readValue(json, McpAuth.class));

        String legacyJson = "{\"mode\":\"oauth\",\"clientId\":null,\"scopes\":[],\"authorizationServer\":null,\"oauth\":true}";
        McpAuth parsed = mapper.readValue(legacyJson, McpAuth.class);
        assertTrue(parsed.isOauth());
        assertEquals(original, parsed);
    }
}
