package com.summit.dp.toolcall.domain.model;

/**
 * 人工决策的下发动作（{@code ToolCallVO.allowedActions} 的元素）。
 *
 * <p><b>wire 值一字不可改：</b>前端按字面量渲染按钮并回传决策，新增值必须先确认前端有对应用例。</p>
 */
public enum ToolCallAction {

    /** 批准：放行执行 / 提交计划 / 选定选项。 */
    APPROVE("APPROVE"),
    /** 拒绝：终态收口，结论写 rejected。 */
    REJECT("REJECT"),
    /** 答复：CHOICE 卡片的选项提交。 */
    ANSWER("ANSWER");

    private final String wireValue;

    ToolCallAction(String wireValue) {
        this.wireValue = wireValue;
    }

    /** 下发给前端的字面量。 */
    public String wireValue() {
        return wireValue;
    }
}
