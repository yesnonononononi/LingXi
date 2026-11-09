package com.summit.dp.session.application.convert;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.summit.core.audit.AuditStatus;
import com.summit.core.audit.DocumentElement;
import com.summit.core.audit.token.OtherTokens;
import com.summit.core.audit.token.TokenAuditDocument;
import com.summit.core.audit.token.tool.ToolAuditDocument;
import com.summit.core.audit.token.tool.ToolElement;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionTokenAuditVO;
import com.summit.dp.shared.vo.TokenAuditCategoryVO;
import com.summit.dp.shared.vo.TokenAuditContextAttributionVO;
import com.summit.dp.shared.vo.TokenAuditOverheadItemVO;
import com.summit.dp.shared.vo.TokenAuditOrdinaryToolsVO;
import com.summit.dp.shared.vo.TokenAuditRequestOverheadVO;
import com.summit.dp.shared.vo.TokenAuditToolBreakdownVO;
import com.summit.dp.shared.vo.TokenAuditToolGroupVO;
import com.summit.dp.shared.vo.TokenAuditToolItemVO;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** 保留框架原值；框架未提供的总量与比例不由业务侧补算。 */
public final class TokenAuditFrameworkViewConverter {
    // 独立映射器避免业务全局数值序列化配置改写框架载荷。
    private static final ObjectMapper MAPPER = JsonMapper.builder().build();

    private TokenAuditFrameworkViewConverter() {
    }

    public static String write(TokenAuditDocument document) {
        if (document == null) return null;
        try {
            return MAPPER.writeValueAsString(document);
        } catch (JsonProcessingException exception) {
            throw new ClientException("框架 token 审计数据保存失败");
        }
    }

    public static SessionTokenAuditVO read(String json) {
        if (json == null) return SessionTokenAuditVO.builder().messages(List.of()).build();
        try {
            return toView(MAPPER.readValue(json, TokenAuditDocument.class));
        } catch (JsonProcessingException exception) {
            throw new ClientException("框架 token 审计数据读取失败");
        }
    }

    public static SessionTokenAuditVO toView(TokenAuditDocument document) {
        List<TokenAuditCategoryVO> messages = new ArrayList<>();
        OtherTokens other = document.otherTokens();
        DocumentElement<Integer> attachment = other == null ? null : other.attachmentTokens();
        Integer attachmentTokens = value(attachment);
        addMessage(messages, "SYSTEM", document.systemTokens(), value(document.systemTokens()));
        addMessage(messages, "USER", document.userTokens(), value(document.userTokens()));
        if (attachmentTokens != null && attachmentTokens >= 0) {
            addMessage(messages, "ATTACHMENT", attachment, attachmentTokens);
        }
        addMessage(messages, "AI", document.assistantTokens(), value(document.assistantTokens()));
        ToolAuditDocument tools = value(document.toolTokens());
        addMessage(messages, "TOOL", document.toolTokens(), tools == null ? null : tools.toolTokens());
        TokenAuditOverheadItemVO definition = other == null ? null : amount(other.toolDefinitionTokens());
        TokenAuditOverheadItemVO mcpDefinition = other == null ? null : amount(other.mcpToolDefinitionTokens());
        return SessionTokenAuditVO.builder()
                .messages(messages)
                .tools(tools == null ? null : toolView(document.toolTokens(), tools))
                .requestOverhead(definition == null && mcpDefinition == null ? null
                        : TokenAuditRequestOverheadVO.builder()
                        .itemCount((definition == null ? 0 : 1) + (mcpDefinition == null ? 0 : 1))
                        .toolDefinition(definition).mcpToolDefinition(mcpDefinition).build())
                .contextAttribution(other == null ? null : TokenAuditContextAttributionVO.builder()
                        .memoryTokens(value(other.memoryTokens())).build())
                .build();
    }

    public static void applyLiveUsage(SessionTokenAuditVO view, Integer total, Integer max, Double ratio) {
        view.setLiveTotalTokens(total);
        view.setLiveMaxTokens(max);
        view.setLiveRatio(ratio);
        view.setRemainingTokens(total == null || max == null ? null : max - total);
        // 剩余比例只由框架已用比例换算，不再从计数反推。
        view.setRemainingRatio(ratio == null ? null : 1 - ratio);
    }

    private static void addMessage(List<TokenAuditCategoryVO> messages, String type,
                                   DocumentElement<?> element, Integer tokens) {
        if (tokens == null) return;
        messages.add(TokenAuditCategoryVO.builder().type(type).tokens(tokens)
                .ratio(element.getRatio()).expandable("TOOL".equals(type)).build());
    }

    private static TokenAuditOverheadItemVO amount(DocumentElement<Integer> element) {
        Integer tokens = value(element);
        return tokens == null ? null : TokenAuditOverheadItemVO.builder()
                .tokens(tokens).ratio(element.getRatio()).build();
    }

    private static TokenAuditToolBreakdownVO toolView(DocumentElement<ToolAuditDocument> element,
                                                       ToolAuditDocument document) {
        List<TokenAuditToolItemVO> items = new ArrayList<>();
        if (document.tokenDetails() != null) {
            for (Map.Entry<String, ToolElement> entry : document.tokenDetails().entrySet()) {
                ToolElement item = entry.getValue();
                if (item == null) continue;
                items.add(TokenAuditToolItemVO.builder().toolName(entry.getKey()).tokens(item.totalTokens())
                        .argumentTokens(item.argumentTokens()).outputTokens(item.outputTokens()).build());
            }
        }
        // 普通工具只有逐工具计数，没有组总量和比例，不能以求和或减法补齐。
        TokenAuditOrdinaryToolsVO ordinary = items.isEmpty() ? null : new TokenAuditOrdinaryToolsVO(items);
        return TokenAuditToolBreakdownVO.builder().tokens(document.toolTokens()).ratio(element.getRatio())
                .ordinary(ordinary).mcp(group("MCP", document.mcpDetail()))
                .skill(group("SKILL", document.skillDetail())).build();
    }

    private static TokenAuditToolGroupVO group(String kind, DocumentElement<ToolElement> element) {
        ToolElement item = value(element);
        return item == null ? null : TokenAuditToolGroupVO.builder().groupKind(kind)
                .tokens(item.totalTokens()).ratio(element.getRatio()).build();
    }

    private static <T> T value(DocumentElement<T> element) {
        return element != null && element.getStatus() == AuditStatus.SUCCESS ? element.getTokenMeta() : null;
    }
}
