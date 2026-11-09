package com.summit.dp.device.interfaces.ws;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 接收侧的序号守卫：丢弃重复消息与乱序消息。
 *
 * <p>为什么需要：WSS 断线重连后，对面的重发队列可能把旧消息再推一遍。若不加守卫，
 * 一次「动作结果」被重复投递就可能让上层把同一动作记成功两次，进而让幂等台账失去意义。</p>
 *
 * <p>两条判据都必需：<b>seq 单调</b>挡乱序与重放；<b>消息 id 去重</b>挡「seq 变了但语义重复」
 * （例如 App 重启后 seq 归零——这时只有 id 能认出来是同一件事）。</p>
 */
public class SeqGuard {

    /** 记住最近多少条消息 id。设备端一次任务通常几十步，500 足够覆盖一次完整任务的回溯。 */
    private static final int ID_MEMORY = 500;

    private long highestSeq = -1;

    private final Map<String, Boolean> seenIds = new LinkedHashMap<>(ID_MEMORY, 0.75f, false) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
            return size() > ID_MEMORY;
        }
    };

    /**
     * 判定一条入站消息是否应当被接受。
     *
     * @param id  消息唯一标识
     * @param seq 发送序号
     * @return true = 首次出现且序号前进，可以处理；false = 重复或乱序，必须丢弃
     */
    public synchronized boolean accept(String id, long seq) {
        if (id != null && seenIds.containsKey(id)) {
            return false;
        }
        // 严格大于：等于也丢弃。同一 seq 出现两次，说明对面序号管理有问题，按重复处理最安全
        if (seq <= highestSeq) {
            return false;
        }
        highestSeq = seq;
        if (id != null) {
            seenIds.put(id, Boolean.TRUE);
        }
        return true;
    }

    public synchronized long highestSeq() {
        return highestSeq;
    }
}
