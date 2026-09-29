package com.summit.dp.mcp.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

/**
 * Mcp 持久化对象。
 *
 * <p><b>存储决策：</b></p>
 * <ul>
 *   <li>{@code headers} 存 JSON 字符串而非子表——它只是随请求下行的不透明键值对，
 *       没有独立查询/关联需求，拆表只会换来无谓的 join；</li>
 *   <li>两个超时存 <b>毫秒数</b>（BIGINT）而非 DATETIME——{@link java.time.Duration} 精度到纳秒，
 *       且语义是「间隔」不是「时刻」，用 DATETIME 会引入无意义的时区与舍入问题；</li>
 *   <li>{@code max_output} 用 INT——框架侧 record 声明为 {@code int}。</li>
 * </ul>
 */
@Builder
@Getter
@TableName("mcp")
public class McpPO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String name;
    private String transport;
    private String url;
    /** JSON 对象字符串，如 {"Authorization":"Bearer xxx"} */
    private String headers;
    private String toolNamePrefix;
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
