package com.summit.dp.shared.vo.block;

import java.math.BigInteger;

/** 同轮新响应按框架身份排序；旧 UUID 历史仍使用持久化序号。 */
public final class BlockOrder {
    private BlockOrder() {
    }

    public static boolean isOrderedResponse(String responseId) {
        return responseId != null && responseId.matches("[0-9]+");
    }

    public static int thinking(String responseId, Integer legacyOrder) {
        return resolveOrder(responseId, legacyOrder, 0);
    }

    public static int text(String responseId, Integer legacyOrder) {
        return resolveOrder(responseId, legacyOrder, 1);
    }

    public static int tool(String responseId, Integer legacyOrder, int requestIndex) {
        return resolveOrder(responseId, legacyOrder, 2 + requestIndex);
    }

    private static int resolveOrder(String responseId, Integer legacyOrder, int slot) {
        return isOrderedResponse(responseId) ? slot : (legacyOrder == null ? 0 : legacyOrder) * 1000 + slot;
    }

    public static int compare(Block left, Block right) {
        boolean leftOrdered = isOrderedResponse(left.getResponseId());
        boolean rightOrdered = isOrderedResponse(right.getResponseId());
        if (leftOrdered && rightOrdered) {
            int response = new BigInteger(left.getResponseId()).compareTo(new BigInteger(right.getResponseId()));
            if (response != 0) return response;
        } else if (leftOrdered != rightOrdered) {
            return leftOrdered ? 1 : -1;
        }
        return Integer.compare(left.getOrder(), right.getOrder());
    }
}
