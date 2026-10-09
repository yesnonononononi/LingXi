package com.summit.dp.shared.vo.block;

/** 实时事件与历史视图共用位置，避免快照到达后重新插队。 */
public final class BlockOrder {
    private static final int RESPONSE_STRIDE = 1000;

    private BlockOrder() {
    }

    public static int thinking(int responseOrder) {
        return responseOrder * RESPONSE_STRIDE;
    }

    public static int text(int responseOrder) {
        return thinking(responseOrder) + 1;
    }

    public static int tool(int responseOrder, int requestIndex) {
        return thinking(responseOrder) + 2 + requestIndex;
    }
}
