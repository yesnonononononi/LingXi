package com.summit.dp.workflow.application.input;

/** 跨轮次续跑文本协议里「不属于任何单个通道」的那几段固定措辞。 */
public final class PendingInputTexts {

    /**
     * 续跑提示语：告诉模型这批输入是新到达的、需要接续处理。
     *
     * <p>逐字保留改造前的措辞与换行 —— 它进入的是模型上下文，一个冒号或换行的变化都会改变提示效果。</p>
     */
    public static final String CONTINUATION_HEADER = "以下是新到达的协作与任务输入，请接续处理：\n";

    private PendingInputTexts() {
    }
}
