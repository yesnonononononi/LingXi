package com.summit.dp.shared.support;

import org.apache.ibatis.cache.CacheKey;
import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.BoundSql;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.plugin.Interceptor;
import org.apache.ibatis.plugin.Intercepts;
import org.apache.ibatis.plugin.Invocation;
import org.apache.ibatis.plugin.Signature;
import org.apache.ibatis.session.ResultHandler;
import org.apache.ibatis.session.RowBounds;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * 测试用 SQL 捕获拦截器：记录真实下发的 SQL 文本（占位符形式）。
 *
 * <p><b>为什么必须拦 Executor</b>：列裁剪的唯一可验证事实是「下发的 SELECT 里有没有那个 CLOB 列」。
 * 只断言「方法被调用」「模型字段为 null」都不够 —— 后者在 CLOB 被读出又赋 null 时同样成立。
 * 绑定到 {@code Executor.query/update} 才能在 SQL 真正下发前拿到 {@code BoundSql}。</p>
 *
 * <p>用法：{@code configuration.addInterceptor(interceptor)} 后再构造 SqlSessionFactory。
 * 断言前先 {@link #clear()}，避免把建库/铺数据的语句算进来。</p>
 */
@Intercepts({
        @Signature(type = Executor.class, method = "query",
                args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
        @Signature(type = Executor.class, method = "query",
                args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class,
                        CacheKey.class, BoundSql.class}),
        @Signature(type = Executor.class, method = "update",
                args = {MappedStatement.class, Object.class})
})
public final class SqlCaptureInterceptor implements Interceptor {

    private final List<String> queries = Collections.synchronizedList(new ArrayList<>());
    private final List<String> updates = Collections.synchronizedList(new ArrayList<>());

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        String sql = resolveSql(invocation);
        if (sql != null) {
            String statementId = invocation.getArgs()[0] instanceof MappedStatement statement
                    ? statement.getId() : "";
            String entry = statementId + " :: " + sql;
            if ("update".equals(invocation.getMethod().getName())) {
                updates.add(entry);
            } else {
                queries.add(entry);
            }
        }
        return invocation.proceed();
    }

    /** 取本次调用的 SQL；无法取到时返回 {@code null}（不记录，不抛异常）。 */
    private static String resolveSql(Invocation invocation) {
        Object[] args = invocation.getArgs();
        if (!(args[0] instanceof MappedStatement statement)) {
            return null;
        }
        try {
            BoundSql boundSql = args.length == 6 && args[5] instanceof BoundSql given
                    ? given : statement.getBoundSql(args[1]);
            return normalize(boundSql.getSql());
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    /** 折叠空白并转小写，让「不含某列」的断言不受换行与大小写影响。 */
    public static String normalize(String sql) {
        return sql == null ? "" : sql.replaceAll("\\s+", " ").trim().toLowerCase(Locale.ROOT);
    }

    /** 已记录的查询语句（含分页 count），每条形如 {@code statementId :: sql}。 */
    public List<String> queries() {
        synchronized (queries) {
            return List.copyOf(queries);
        }
    }

    /** 已记录的写入语句（insert / update / delete）。 */
    public List<String> updates() {
        synchronized (updates) {
            return List.copyOf(updates);
        }
    }

    /** 清空历史记录，便于只断言被测方法自己发出的语句。 */
    public void clear() {
        queries.clear();
        updates.clear();
    }

    /** 断言辅助：给定语句是否出现某列名（小写、去空白后包含即可）。 */
    public static boolean hasColumn(String statement, String column) {
        return normalize(statement).contains(column.toLowerCase(Locale.ROOT));
    }
}
