package com.summit.dp.session.application.port;

import java.util.Collection;

/**
 * 会话级图片缓存的删除端口。
 *
 * <p><b>为什么图片跟着会话走</b>：缓存目录按会话分（{@code images/<sessionId>/}），文件名是内容哈希，
 * 谁引用哪张图只存在于消息与工具卡片的内容里。会话一删，这些引用同时消失，
 * 所以「删会话 → 删该会话的图片目录」是唯一不误伤未删会话的判据；不去反查消息正文里引用了哪个哈希，
 * 那种判据既昂贵又脆弱。</p>
 */
public interface SessionImageCache {

    /**
     * 删除这些会话的图片缓存目录（会话行已提交删除之后调用）。
     *
     * <p>删不掉只记录不抛出：会话已经不在了，图片残留只是磁盘垃圾，由孤儿清扫带走。</p>
     *
     * @param sessionIds 会话 id 集合；空入参直接返回
     */
    void deleteSessions(Collection<Long> sessionIds);
}
