package com.summit.dp.shared.persistence.handler.h2;

import com.summit.dp.shared.persistence.UtcTimestampCodec;
import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.MappedTypes;

import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDateTime;

/**
 * {@link LocalDateTime} ↔ H2 {@code TIMESTAMP(3)} 的读写。
 *
 * <p>语义与 SQLite 侧 {@code LocalDateTimeTextTypeHandler} 一致：本地时间先按 JVM 默认时区折成瞬时
 * 再以 UTC 落库，读回时按同一时区还原；精度统一毫秒。跨引擎的等价性由同一个测试双跑断言。</p>
 */
@MappedTypes(LocalDateTime.class)
public class H2LocalDateTimeTypeHandler extends BaseTypeHandler<LocalDateTime> {

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, LocalDateTime parameter, JdbcType jdbcType)
            throws SQLException {
        ps.setTimestamp(i, UtcTimestampCodec.toTimestamp(parameter), UtcTimestampCodec.utcCalendar());
    }

    @Override
    public LocalDateTime getNullableResult(ResultSet rs, String columnName) throws SQLException {
        return UtcTimestampCodec.toLocalDateTime(rs.getTimestamp(columnName, UtcTimestampCodec.utcCalendar()));
    }

    @Override
    public LocalDateTime getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
        return UtcTimestampCodec.toLocalDateTime(rs.getTimestamp(columnIndex, UtcTimestampCodec.utcCalendar()));
    }

    @Override
    public LocalDateTime getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
        return UtcTimestampCodec.toLocalDateTime(cs.getTimestamp(columnIndex, UtcTimestampCodec.utcCalendar()));
    }
}
