package com.summit.dp.shared.vo.block;

import java.math.BigInteger;

/** 同轮响应按框架身份排序，块内位置只负责展示优先级。 */
public final class BlockOrder {
    private BlockOrder() {
    }

    public static int thinking() {
        return 0;
    }

    public static int text() {
        return 1;
    }

    public static int tool(int requestIndex) {
        return 2 + requestIndex;
    }

    public static int compare(Block left, Block right) {
        int response = new BigInteger(left.getResponseId()).compareTo(new BigInteger(right.getResponseId()));
        return response != 0 ? response : Integer.compare(left.getOrder(), right.getOrder());
    }
}
