package com.summit.dp.shared.persistence.handler.sqlite;

import com.summit.dp.shared.persistence.TimeTextCodec;
import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.MappedTypes;

import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDateTime;

/**
 * {@link LocalDateTime} ↔ SQLite 文本时间的读写。
 *
 * <p>库里的时间只保证毫秒精度，写回时统一截断到毫秒 —— 否则「写 123.456789ms、读回 123ms」
 * 会让等值断言和版本比较在不同精度上打架。</p>
 *
 * <p>包位置说明：与 {@link InstantTextTypeHandler} 同属 SQLite 分支，按引擎扫描注册。</p>
 */
@MappedTypes(LocalDateTime.class)
public class LocalDateTimeTextTypeHandler extends BaseTypeHandler<LocalDateTime> {

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, LocalDateTime parameter, JdbcType jdbcType)
            throws SQLException {
        ps.setString(i, TimeTextCodec.format(parameter));
    }

    @Override
    public LocalDateTime getNullableResult(ResultSet rs, String columnName) throws SQLException {
        return TimeTextCodec.toLocalDateTime(rs.getString(columnName));
    }

    @Override
    public LocalDateTime getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
        return TimeTextCodec.toLocalDateTime(rs.getString(columnIndex));
    }

    @Override
    public LocalDateTime getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
        return TimeTextCodec.toLocalDateTime(cs.getString(columnIndex));
    }
}
