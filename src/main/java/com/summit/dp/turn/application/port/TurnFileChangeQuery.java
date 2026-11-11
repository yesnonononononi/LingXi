package com.summit.dp.turn.application.port;

import com.summit.dp.shared.vo.block.TurnFileChangeVO;

import java.util.List;

/**
 * 轮次改动清单的读端口。
 *
 * <p><b>为什么是端口而不是直接注入实现</b>：实现（{@code TurnFileEditSummaryService}）住在
 * {@code workflow} 模块，它是文件编辑记录的唯一持有者；而装配轮次视图的
 * {@code session.TurnViewService} 不该反过来依赖 workflow —— 那样 {@code session ↔ workflow}
 * 会形成双向包依赖。端口放在 {@code turn} 模块（轮次视图与文件编辑者共同的下游），
 * 由 workflow 侧实现并注入。</p>
 *
 * <p><b>返回值是净改动</b>：同一文件在本轮内的多次编辑必须由实现合并重算，
 * 调用方不得逐次累加。</p>
 */
public interface TurnFileChangeQuery {

    /**
     * 汇总一轮内所有文件的净改动。
     *
     * @param turnId 业务轮次 ID
     * @return 按文件首次出现顺序排列的改动清单；轮次不存在或尚未绑定执行时为**空列表**（不是 null）
     */
    List<TurnFileChangeVO> summarize(long turnId);
}
