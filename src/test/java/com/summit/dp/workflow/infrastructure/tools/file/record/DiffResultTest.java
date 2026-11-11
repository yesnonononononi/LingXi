package com.summit.dp.workflow.infrastructure.tools.file.record;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 差异结果的取值口径。
 *
 * <p>看起来是琐碎的 getter，但每一处判断都直接决定界面上的数字：{@code isSuccess} 反过来，
 * 失败的差异会被当成成功展示；{@code unifiedDiff} 不兜 {@code null}，就会在没差异时抛空指针，
 * 而这条路径正是「只删一行」的常见形态。</p>
 */
class DiffResultTest {

    @Test
    void successResultReturnsItsDiffAndCountsMarkedLines() {
        DiffResult result = DiffResult.success(List.of(
                "--- a.txt", "+++ b.txt", "@@ -1 +1 @@", "+added", "-removed", " context", "+again"));

        assertTrue(result.isSuccess(), "成功标记必须能判成功");
        assertEquals("+added", result.unifiedDiff().lines().skip(3).findFirst().orElseThrow());
        assertEquals(2, result.plusLines(), "只数差异块内的 + 行，文件头不算");
        assertEquals(1, result.minusLines());
    }

    @Test
    void failedResultHasNoDiffText() {
        DiffResult result = DiffResult.fail("重放失败");

        assertFalse(result.isSuccess(), "失败标记不能被当成成功");
        assertEquals("", result.unifiedDiff(), "没有差异正文时给空串，不能抛空指针");
        assertEquals(0, result.plusLines());
        assertEquals(0, result.minusLines());
        assertEquals("重放失败", result.getErrMsg());
    }
}
