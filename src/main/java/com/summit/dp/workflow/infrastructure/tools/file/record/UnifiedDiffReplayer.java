package com.summit.dp.workflow.infrastructure.tools.file.record;

import com.github.difflib.UnifiedDiffUtils;
import com.github.difflib.patch.Patch;
import lombok.extern.slf4j.Slf4j;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

/**
 * 把 unified diff 依次重放回基线，重建文件内容。
 *
 * <p><b>为什么需要它</b>：记录只存差异（见 {@link FileRecord}），要算「本轮这个文件总共改了什么」
 * 就必须先把各次修改叠回去得到末态，再与基线做一次完整差异。逐次把 {@code +N/−M} 相加是错的：
 * 同一行被改两次会被记成两次增删。</p>
 *
 * <p><b>为什么直接复用 java-diff-utils</b>：差异也是它生成的（{@code UnifiedDiffUtils.generateUnifiedDiff}），
 * 解析与应用的格式口径天然一致；自己写解析器只会在「\ No newline at end of file」「空 hunk」这些
 * 边角上与生成侧悄悄漂移。</p>
 */
@Slf4j
public final class UnifiedDiffReplayer {

    private UnifiedDiffReplayer() {
    }

    /**
     * 按顺序把多份 unified diff 叠回基线。
     *
     * @param baseline 基线全文；{@code null} 表示本轮开始时文件不存在，按空文件处理
     * @param diffs    同一文件的各次修改差异，必须按写入顺序给出
     * @return 重放后的全文；任何一份差异与实际内容对不上时返回 {@link Optional#empty()}，
     *         由调用方决定降级口径 —— 绝不返回一个「看起来对」的半成品
     */
    public static Optional<String> replay(String baseline, List<String> diffs) {
        // 与 EditDiffer 完全一致的行切分口径（-1 保留末尾空段），否则往返会差一个换行。
        List<String> lines = new ArrayList<>(Arrays.asList((baseline == null ? "" : baseline).split("\\R", -1)));
        try {
            for (String diff : diffs) {
                if (diff == null || diff.isBlank()) {
                    continue;
                }
                Patch<String> patch = UnifiedDiffUtils.parseUnifiedDiff(
                        new ArrayList<>(Arrays.asList(diff.split("\\R", -1))));
                lines = new ArrayList<>(patch.applyTo(lines));
            }
        } catch (Exception e) {
            log.warn("差异重放失败，本条改动无法重建末态: reason={}", e.getMessage());
            return Optional.empty();
        }
        return Optional.of(String.join("\n", lines));
    }
}
