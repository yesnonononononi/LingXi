package com.summit.dp.session.domain.model;

import lombok.NonNull;

public record TokenUsage(int totalTokens, int inputTokens, int outputTokens) {
    public TokenUsage{
        if (totalTokens < 0 || inputTokens < 0 || outputTokens < 0) {
            throw new IllegalArgumentException("Tokens cannot be negative");
        }
    }
    public static TokenUsage empty() { return new TokenUsage(0, 0, 0); }
    public TokenUsage add(@NonNull TokenUsage tokenUsage) {
        int newTotalTokens = this.totalTokens + tokenUsage.totalTokens();
        int newInputTokens = this.inputTokens + tokenUsage.inputTokens();
        int newOutputTokens = this.outputTokens + tokenUsage.outputTokens();
        return new TokenUsage(newTotalTokens, newInputTokens, newOutputTokens);
    }
}
