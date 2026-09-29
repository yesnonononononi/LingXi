package com.summit.dp.tools.baseTools.arguments;

import lombok.Data;

/**
 * {@code send_mail_to_agent} 的工具参数。
 *
 * <p>只承载「发给谁」与「发什么」两件事，字段名与 {@code ToolConfig} 注册的 JSON Schema 严格一致。
 * 发送者、协作根执行与团队快照都不由模型提供，一律由服务端从受控上下文解析——模型无法指定
 * 邮箱 id 或任何路由字段。</p>
 */
@Data
public class SendMailArgument {
    private Long toAgentId;
    private String mailContent;
}
