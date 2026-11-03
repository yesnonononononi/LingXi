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

/** 时间读写必须显式使用 UTC，不能沿用 JDBC 的默认时区。 */
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
