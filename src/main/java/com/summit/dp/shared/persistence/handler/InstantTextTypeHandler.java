package com.summit.dp.shared.persistence.handler;

import com.summit.dp.shared.persistence.TimeTextCodec;
import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.MappedTypes;

import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;

/**
 * {@link Instant} ↔ SQLite 文本时间的读写。
 *
 * <p>必须替换 MyBatis 内置处理器：内置那个走的是 {@code setTimestamp/getTimestamp}，
 * 而 sqlite-jdbc 这两端格式不一致（写入是毫秒整数、读取按日期串解析），实测直接抛
 * {@code Error parsing time stamp}。</p>
 */
@MappedTypes(Instant.class)
public class InstantTextTypeHandler extends BaseTypeHandler<Instant> {

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, Instant parameter, JdbcType jdbcType)
            throws SQLException {
        ps.setString(i, TimeTextCodec.format(parameter));
    }

    @Override
    public Instant getNullableResult(ResultSet rs, String columnName) throws SQLException {
        return TimeTextCodec.toInstant(rs.getString(columnName));
    }

    @Override
    public Instant getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
        return TimeTextCodec.toInstant(rs.getString(columnIndex));
    }

    @Override
    public Instant getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
        return TimeTextCodec.toInstant(cs.getString(columnIndex));
    }
}
