package com.summit.dp.agent.application.vo;

/**
 * 命令受理状态：v2 受理回执的机器可判别字段。
 *
 * <p><b>为什么受理与重试查回要分开表达</b>：前端在受理回执丢失时按 commandId 重发，
 * 服务端必须能区分「这是首次受理」与「这是同一命令的查回」。若两者都回同一个值，
 * 前端无法判断该不该再等等 —— 统一显示成功会让用户在其实已开跑的情况下再点一次发送。
 * 这里显式给出两种状态，不用「都是 accepted」把差异糊掉。</p>
 */
public enum CommandAcceptance {

    /** 首次受理成功：用户消息与业务轮次已同事务落库，执行已派发。 */
    ACCEPTED("ACCEPTED"),
    /**
     * 同一命令的重复请求，已按 commandId 查回首次受理结果。
     *
     * <p><b>不是新受理</b>：没有写第二条用户消息、没有开启第二个执行。回执里带的是首次的
     * sessionId / turnId / executionId。</p>
     */
    REPLAYED("REPLAYED");

    private final String wireValue;

    CommandAcceptance(String wireValue) {
        this.wireValue = wireValue;
    }

    public String wireValue() {
        return wireValue;
    }
}
