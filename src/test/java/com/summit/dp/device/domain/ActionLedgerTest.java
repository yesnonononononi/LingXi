package com.summit.dp.device.domain;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ActionLedgerTest {

    private static final String DEV_A = "px7a-a";
    private static final String DEV_B = "px7a-b";

    @Test
    void 首次下发可以登记_重复下发必须被拒() {
        ActionLedger ledger = new ActionLedger();

        assertTrue(ledger.markSent("a-1", DEV_A), "首次登记应成功");
        assertFalse(ledger.markSent("a-1", DEV_A), "同一 actionId 重复登记必须失败");
        assertTrue(ledger.isDuplicate("a-1"));
    }

    @Test
    void 执行成功后仍然算已占用() {
        ActionLedger ledger = new ActionLedger();
        ledger.markSent("a-2", DEV_A);
        assertTrue(ledger.markExecuted("a-2"));

        assertEquals(ActionLedger.State.EXECUTED, ledger.stateOf("a-2"));
        assertTrue(ledger.isDuplicate("a-2"), "执行过就不能再执行第二次");
        assertFalse(ledger.markSent("a-2", DEV_A));
    }

    @Test
    void 断线期间在途动作标未确认且永不回放() {
        ActionLedger ledger = new ActionLedger();
        ledger.markSent("a-3", DEV_A);
        ledger.markSent("a-4", DEV_A);
        ledger.markExecuted("a-4");

        ledger.markPendingUnknownOf(DEV_A);

        assertEquals(ActionLedger.State.UNKNOWN, ledger.stateOf("a-3"), "在途动作应转未确认");
        assertEquals(ActionLedger.State.EXECUTED, ledger.stateOf("a-4"), "已执行的事实不能被断线抹掉");
        assertTrue(ledger.isDuplicate("a-3"), "未确认动作也必须占位，否则重连后会重复点");
    }

    /**
     * 这条是本次重构的核心动机：早先版本按全局清理，一台设备断线会把另一台设备的
     * 在途动作也标成 UNKNOWN，让 agent 对着仍然连线的设备做多余的重新观察。
     */
    @Test
    void 一台设备断线不得影响另一台设备() {
        ActionLedger ledger = new ActionLedger();
        ledger.markSent("a-of-a", DEV_A);
        ledger.markSent("a-of-b", DEV_B);

        ledger.markPendingUnknownOf(DEV_A);

        assertEquals(ActionLedger.State.UNKNOWN, ledger.stateOf("a-of-a"));
        assertEquals(ActionLedger.State.SENT, ledger.stateOf("a-of-b"),
                "另一台设备的连接还在，结果仍可能正常返回，提前标未确认会凭空制造一次重复观察");
    }

    @Test
    void 台账记得动作归属哪台设备() {
        ActionLedger ledger = new ActionLedger();
        ledger.markSent("a-owner", DEV_B);

        assertEquals(DEV_B, ledger.deviceOf("a-owner"));
        assertNull(ledger.deviceOf("a-unknown"));
    }

    @Test
    void 未确认不会把已执行降级() {
        ActionLedger ledger = new ActionLedger();
        ledger.markSent("a-5", DEV_A);
        ledger.markExecuted("a-5");

        ledger.markUnknown("a-5");

        assertEquals(ActionLedger.State.EXECUTED, ledger.stateOf("a-5"));
    }

    @Test
    void 空动作标识或空设备标识直接拒绝() {
        ActionLedger ledger = new ActionLedger();
        assertThrows(IllegalArgumentException.class, () -> ledger.markSent(" ", DEV_A));
        assertThrows(IllegalArgumentException.class, () -> ledger.markSent("a-6", " "));
    }

    @Test
    void 未知设备的清理是空操作() {
        ActionLedger ledger = new ActionLedger();
        ledger.markSent("a-7", DEV_A);

        ledger.markPendingUnknownOf("never-seen");
        ledger.markPendingUnknownOf(null);

        assertEquals(ActionLedger.State.SENT, ledger.stateOf("a-7"));
    }
}
