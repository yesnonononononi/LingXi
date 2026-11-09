package com.summit.dp.device.interfaces.ws;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SeqGuardTest {

    @Test
    void 序号前进才接受() {
        SeqGuard guard = new SeqGuard();

        assertTrue(guard.accept("m-1", 0));
        assertTrue(guard.accept("m-2", 1));
        assertTrue(guard.accept("m-3", 2));
        assertEquals(2, guard.highestSeq());
    }

    @Test
    void 重复消息id必须丢弃() {
        SeqGuard guard = new SeqGuard();
        assertTrue(guard.accept("m-1", 0));

        // seq 变了但 id 相同：App 重启后序号归零，这种情况只有 id 认得出来
        assertFalse(guard.accept("m-1", 5));
    }

    @Test
    void 乱序与回退必须丢弃() {
        SeqGuard guard = new SeqGuard();
        guard.accept("m-1", 10);

        assertFalse(guard.accept("m-2", 9), "回退的 seq 说明消息是旧的");
        assertFalse(guard.accept("m-3", 10), "seq 相等按重复处理，宁可丢也不重复处理");
    }

    @Test
    void 缺id时仍按seq守卫() {
        SeqGuard guard = new SeqGuard();
        assertTrue(guard.accept(null, 0));
        assertFalse(guard.accept(null, 0));
        assertTrue(guard.accept(null, 1));
    }
}
