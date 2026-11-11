package com.summit.dp.shared.utils;

import com.summit.core.compact.TokenEstimator;
import com.summit.core.conversation.message.Message;

import java.util.List;

/** 测试用确定性估算器：1 字符 = 1 token，便于构造精确的截断边界。 */
public final class TokenEstimatorTestSupport {

    private TokenEstimatorTestSupport() {
    }

    public static TokenEstimator charCount() {
        return new TokenEstimator() {
            @Override
            public int estimateText(String text) {
                return text == null ? 0 : text.length();
            }

            @Override
            public int estimateMessages(List<Message> messages) {
                // 用到消息估算的用例请改成真实实现，这里只服务纯文本边界。
                return 0;
            }
        };
    }
}