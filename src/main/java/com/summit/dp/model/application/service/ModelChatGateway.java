package com.summit.dp.model.application.service;

import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.model.chat.ChatModel;

/**
 * 业务侧通用的同步文本模型调用点：无工具，一条系统提示加一条用户内容。
 *
 * <p>提示词优化和检索摘要都需要「拿一份连接配置，发一次文本请求」，共享它避免两处各自处理
 * provider 名字与消息组装；响应校验仍由调用方负责，两者失败语义不同。</p>
 */
public interface ModelChatGateway {

    /** 按连接配置生成同步 ChatModel；流式连接名归一化到同协议的同步实现。 */
    ChatModel resolve(ModelConfig config);

    /** 一次无工具的同步文本调用，原样返回响应，finishReason 等判断交给调用方。 */
    ChatResponseEntity chat(ModelConfig config, String systemPrompt, String content);
}
