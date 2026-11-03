package com.summit.dp.shared.persistence.handler;

import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.MappedJdbcTypes;
import org.apache.ibatis.type.MappedTypes;

import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/**
 * 大文本列（H2 {@code CLOB}）与 {@link String} 的互转，两个引擎共用。
 *
 * <p><b>只挂在标注过的列上</b>：{@code @MappedJdbcTypes(CLOB)} 让自动注册只覆盖
 * 「Java 类型 String + JDBC 类型 CLOB」这一组合，不会把普通 {@code VARCHAR} 列也抢过来；
 * 真正生效的是各 PO 字段上的 {@code typeHandler = LargeTextTypeHandler.class}。</p>
 *
 * <p><b>为什么不用 Reader/Writer</b>：业务层要的就是完整 {@code String}（上下文全文、工具输出
 * 都要参与序列化与比较），流式读进来最终仍要落成 String；而写入端两个驱动对
 * {@code setCharacterStream} 的支持差异很大（xerial 部分重载未实现）。CLOB 的落盘形态由
 * <b>列类型</b>决定，与用哪个 setter 无关 —— 列是 CLOB，H2 就按字符大对象存，
 * 这才是「不再把 10 亿字符的 VARCHAR 值整个塞进内存」的关键。
 * 因此写入走 {@code setString}、读取走 {@code getString}，语义最直白且两个驱动都稳定。</p>
 */
@MappedTypes(String.class)
@MappedJdbcTypes(JdbcType.CLOB)
public class LargeTextTypeHandler extends BaseTypeHandler<String> {

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, String parameter, JdbcType jdbcType)
            throws SQLException {
        ps.setString(i, parameter);
    }

    @Override
    public String getNullableResult(ResultSet rs, String columnName) throws SQLException {
        return rs.getString(columnName);
    }

    @Override
    public String getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
        return rs.getString(columnIndex);
    }

    @Override
    public String getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
        return cs.getString(columnIndex);
    }
}
