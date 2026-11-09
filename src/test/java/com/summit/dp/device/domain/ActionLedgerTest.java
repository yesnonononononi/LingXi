package com.summit.dp.device.domain;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ActionLedgerTest {

    @Test
    void 首次下发可以登记_重复下发必须被拒() {
        ActionLedger ledger = new ActionLedger();

        assertTrue(ledger.markSent("a-1"), "首次登记应成功");
        assertFalse(ledger.markSent("a-1"), "同一 actionId 重复登记必须失败");
        assertTrue(ledger.isDuplicate("a-1"));
    }

    @Test
    void 执行成功后仍然算已占用() {
        ActionLedger ledger = new ActionLedger();
        ledger.markSent("a-2");
        assertTrue(ledger.markExecuted("a-2"));

        assertEquals(ActionLedger.State.EXECUTED, ledger.stateOf("a-2"));
        assertTrue(ledger.isDuplicate("a-2"), "执行过就不能再执行第二次");
        assertFalse(ledger.markSent("a-2"));
    }

    @Test
    void 断线期间在途动作标未确认且永不回放() {
        ActionLedger ledger = new ActionLedger();
        ledger.markSent("a-3");
        ledger.markSent("a-4");
        ledger.markExecuted("a-4");

        ledger.markAllPendingUnknown();

        assertEquals(ActionLedger.State.UNKNOWN, ledger.stateOf("a-3"), "在途动作应转未确认");
        assertEquals(ActionLedger.State.EXECUTED, ledger.stateOf("a-4"), "已执行的事实不能被断线抹掉");
        assertTrue(ledger.isDuplicate("a-3"), "未确认动作也必须占位，否则重连后会重复点");
    }

    @Test
    void 未确认不会把已执行降级() {
        ActionLedger ledger = new ActionLedger();
        ledger.markSent("a-5");
        ledger.markExecuted("a-5");

        ledger.markUnknown("a-5");

        assertEquals(ActionLedger.State.EXECUTED, ledger.stateOf("a-5"));
    }

    @Test
    void 空动作标识直接拒绝() {
        ActionLedger ledger = new ActionLedger();
        org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
                () -> ledger.markSent(" "));
    }
}
