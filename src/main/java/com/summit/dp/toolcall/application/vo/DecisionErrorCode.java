package com.summit.dp.toolcall.application.vo;

/**
 * v2 决策入口的机器可判别业务码。
 *
 * <p><b>为什么必须有码，不能只靠中文文案</b>：前端要按「冲突 / 已决 / 未就绪 / 已结束 / 恢复失败」
 * 分别采取不同动作 —— 冲突要刷新卡片，已决要采纳已有结论，未就绪要禁用按钮等一会儿，
 * 已结束要停止轮询。只给一句中文，前端只能对文案做字符串匹配，
 * 改一次文案就静默改坏了行为。</p>
 *
 * <p><b>为什么「尚未暂停」与「已经结束」必须是两个码</b>：两者的用户动作完全相反 ——
 * 前者应当继续等并重试，后者重试一万次也不会成功（执行已经终结，决策永远不会生效）。
 * 合成一句「稍后重试」会让用户在已结束的场景下无限重试，界面永远转圈。</p>
 */
public enum DecisionErrorCode {

    /** 版本冲突：expectedVersion 与当前卡片版本不符，决策未落库。 */
    STATE_CONFLICT(4090, "卡片已被其他操作更新，请刷新后重试"),
    /** 该互动已有结论（且不是本次命令落定的）：返回实际最新视图，不覆盖。 */
    DECISION_ALREADY_APPLIED(4091, "该互动已有结论，请查看最新状态"),
    /** 互动尚未就绪（准备中 / 未暂停），决策未落库。 */
    INTERACTION_NOT_READY(4092, "互动尚未就绪，请等待执行暂停后再提交"),
    /** 所属执行已终结，决策不会再触发恢复。 */
    EXECUTION_ENDED(4093, "执行已结束，该决策不会再生效"),
    /** 决策已落库，但恢复意图派发失败。 */
    RESUME_FAILED(4094, "决策已保存，但恢复执行失败，请重试恢复"),
    /** 同一命令标识对应了不同的请求内容。 */
    COMMAND_CONFLICT(4095, "同一命令标识对应了不同的请求内容，请刷新后重新提交");

    private final int code;
    private final String message;

    DecisionErrorCode(int code, String message) {
        this.code = code;
        this.message = message;
    }

    public int code() {
        return code;
    }

    public String message() {
        return message;
    }
}
