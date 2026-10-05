package com.summit.dp.mcp.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Builder;
import lombok.Getter;
import lombok.extern.jackson.Jacksonized;

import java.time.Instant;

/**
 * Mcp 持久化对象。
 *
 * <p><b>存储决策：</b></p>
 * <ul>
 *   <li>{@code headers} / {@code env} 存 JSON 字符串而非子表——它们只是随请求下行的不透明键值对，
 *       没有独立查询/关联需求，拆表只会换来无谓的 join；</li>
 *   <li>{@code command} 存 JSON 数组字符串——stdio 启动命令是 argv 列表，逐段保留可避免
 *       整行 shell 字符串的空格/引号转义歧义；</li>
 *   <li>{@code url} 允许 NULL——stdio 传输没有端点，由 command 承担连接职责；</li>
 *   <li>两个超时存 <b>毫秒数</b>（BIGINT）而非 DATETIME——{@link java.time.Duration} 精度到纳秒，
 *       且语义是「间隔」不是「时刻」，用 DATETIME 会引入无意义的时区与舍入问题；</li>
 *   <li>{@code max_output} 用 INT——框架侧 record 声明为 {@code int}。</li>
 * </ul>
 */
@Builder(toBuilder = true)
@Jacksonized
@Getter
@TableName("mcp")
public class McpPO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String name;
    private String transport;
    /** http 系传输的端点；stdio 传输为 null */
    private String url;
    /** JSON 对象字符串，如 {"Authorization":"Bearer xxx"} */
    private String headers;
    /** JSON 数组字符串，如 ["npx","shadcn@latest","mcp"]；仅 stdio 传输 */
    private String command;
    /** JSON 对象字符串，如 {"GITHUB_TOKEN":"xxx"}；仅 stdio 传输 */
    private String env;
    /** 服务描述，随提示词下发给模型；由业务用户填写 */
    private String description;
    /** 初始化超时，毫秒 */
    private Long initializationTimeout;
    /** 执行超时，毫秒 */
    private Long executionTimeout;
    private Integer maxOutput;
    /** 1 = 启用，0 = 停用 */
    private Integer status;
    private Instant createTime;
    private Instant updateTime;
}
