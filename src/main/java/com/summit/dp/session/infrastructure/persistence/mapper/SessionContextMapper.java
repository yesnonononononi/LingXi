package com.summit.dp.session.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.util.List;

@Mapper
public interface SessionContextMapper extends BaseMapper<SessionContextPO> {

    /**
     * 取一批「正文还在库里、尚未搬成文件」的历史行，供启动迁移逐条外置。
     *
     * <p>只在这个迁移路径上读 {@code content}：搬完即置空，之后整条读路径都不再经过它。
     * 按主键游标翻页（{@code session_id > afterSessionId}）而不是 LIMIT 从头取，
     * 否则失败行会永远占住队头，把后面的行挡在门外。</p>
     */
    @Select("SELECT session_id, content FROM session_context"
            + " WHERE snapshot_file IS NULL AND content IS NOT NULL AND session_id > #{afterSessionId}"
            + " ORDER BY session_id LIMIT #{limit}")
    List<SessionContextPO> selectLegacyContexts(@Param("afterSessionId") long afterSessionId,
                                                @Param("limit") int limit);

    /**
     * 记下正文标识并清掉库内旧正文（迁移专用）。
     *
     * <p>带 {@code snapshot_file IS NULL} 条件：并发/重入时第二次命中 0 行，
     * 不会把别人刚写好的引用覆盖掉。返回实际更新行数。</p>
     */
    @Update("UPDATE session_context SET snapshot_file = #{snapshotFile}, content = NULL"
            + " WHERE session_id = #{sessionId} AND snapshot_file IS NULL")
    int assignSnapshotFile(@Param("sessionId") long sessionId, @Param("snapshotFile") String snapshotFile);
}

