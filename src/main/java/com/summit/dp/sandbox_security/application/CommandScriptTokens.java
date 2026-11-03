package com.summit.dp.sandbox_security.application;

import java.util.ArrayList;
import java.util.List;

/** 保留带引号参数的边界，避免把打印和检索的文本误判为命令。 */
final class CommandScriptTokens {
    private CommandScriptTokens() { }

    static List<List<Token>> parse(String command) {
        List<List<Token>> segments = new ArrayList<>();
        List<Token> tokens = new ArrayList<>();
        StringBuilder token = new StringBuilder();
        char quote = 0;
        for (int index = 0; index < command.length(); index++) {
            char value = command.charAt(index);
            if (quote != 0) {
                if (value == quote) quote = 0;
                else token.append(value);
                continue;
            }
            if (value == '"' || value == '\'') { quote = value; continue; }
            if (value == ';' || value == '&' || value == '|' || value == '\n' || value == '\r') {
                if (!token.isEmpty()) { tokens.add(new Token(token.toString(), false)); token.setLength(0); }
                if (!tokens.isEmpty()) { segments.add(List.copyOf(tokens)); tokens.clear(); }
            } else if (Character.isWhitespace(value)) {
                if (!token.isEmpty()) { tokens.add(new Token(token.toString(), false)); token.setLength(0); }
            } else if (value == '>') {
                if (!token.isEmpty()) { tokens.add(new Token(token.toString(), false)); token.setLength(0); }
                if (index + 1 < command.length() && command.charAt(index + 1) == '>') { tokens.add(new Token(">>", true)); index++; }
                else tokens.add(new Token(">", true));
            } else {
                token.append(value);
            }
        }
        if (!token.isEmpty()) tokens.add(new Token(token.toString(), false));
        if (!tokens.isEmpty()) segments.add(List.copyOf(tokens));
        return segments;
    }

    record Token(String text, boolean outputRedirect) { }
}
