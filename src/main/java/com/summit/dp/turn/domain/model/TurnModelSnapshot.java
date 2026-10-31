package com.summit.dp.turn.domain.model;

/**
 * 受理时冻结的模型快照：本轮用了哪个模型、哪个提供方、哪一档思考强度。
 *
 * <p>三项一起传，是因为「本轮到底思考多深」必须与模型同时落在同一个事实里 —— 分开传就总有
 * 一处忘了带，事后只能翻运行配置版本去猜。思考档可为 {@code null}（该轮早于该字段落库）。</p>
 *
 * @param modelName       受理时业务解析出的模型名
 * @param modelProvider   受理时业务解析出的提供方
 * @param reasoningEffort 本轮思考强度档位（{@code none/low/medium/high/xhigh/max}）
 */
public record TurnModelSnapshot(String modelName, String modelProvider, String reasoningEffort) {

    public static TurnModelSnapshot of(String modelName, String modelProvider, String reasoningEffort) {
        return new TurnModelSnapshot(modelName, modelProvider, reasoningEffort);
    }
}
