package com.summit.dp.shared.persistence.handler.h2;

import com.summit.dp.shared.persistence.UtcTimestampCodec;
import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.MappedTypes;

import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;

/**
 * {@link Instant} ↔ H2 {@code TIMESTAMP(3)} 的读写（UTC Calendar + 会话 UTC）。
 *
 * <p>与 SQLite 侧 {@code InstantTextTypeHandler} 的语义完全等价：同一个瞬时在两个引擎上
 * 读出同一个值。差别只在落盘形态（UTC 文本 vs UTC 墙钟时间戳），因此必须按引擎分派处理器，
 * 否则 H2 上会走文本写入、SQLite 上会走 Timestamp 写入，两边都出错。</p>
 */
@MappedTypes(Instant.class)
public class H2InstantTypeHandler extends BaseTypeHandler<Instant> {

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, Instant parameter, JdbcType jdbcType)
            throws SQLException {
        ps.setTimestamp(i, UtcTimestampCodec.toTimestamp(parameter), UtcTimestampCodec.utcCalendar());
    }

    @Override
    public Instant getNullableResult(ResultSet rs, String columnName) throws SQLException {
        return UtcTimestampCodec.toInstant(rs.getTimestamp(columnName, UtcTimestampCodec.utcCalendar()));
    }

    @Override
    public Instant getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
        return UtcTimestampCodec.toInstant(rs.getTimestamp(columnIndex, UtcTimestampCodec.utcCalendar()));
    }

    @Override
    public Instant getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
        return UtcTimestampCodec.toInstant(cs.getTimestamp(columnIndex, UtcTimestampCodec.utcCalendar()));
    }
}
