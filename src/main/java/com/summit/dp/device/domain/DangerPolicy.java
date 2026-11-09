package com.summit.dp.device.domain;

import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * 危险动作判定。
 *
 * <p>规则放在电脑端而不是 App 里：App 只执行、不决策。这样换一台设备、换一个 agent 实现时，
 * 策略仍然只有这一份，也不会出现「App 觉得这个应该没事就自己点了」。</p>
 */
public class DangerPolicy {

    /** 命中即高危：这些词一旦出现，点下去的后果不可撤销。 */
    private static final Set<String> HIGH_RISK_KEYWORDS = Set.of(
            "转账", "支付", "付款", "确认支付", "立即支付", "删除", "卸载",
            "格式化", "授权", "解除绑定", "退出登录", "清空", "注销"
    );

    /**
     * 在这些应用内操作默认中危：多数不可撤销的动作都发生在这里。
     *
     * <p>刻意<b>不</b>包含 com.android.settings：设置页里绝大多数操作（开关 WiFi、调亮度）
     * 完全无害，整包拦截只会制造确认疲劳——用户开始闭眼点"同意"，真正危险的那次也就废了。
     * 设置里的危险动作（卸载、恢复出厂）本身就会命中高危关键词，不需要包名兜底。</p>
     */
    private static final Set<String> MEDIUM_RISK_PACKAGES = Set.of(
            "com.eg.android.alipaygphone",   // 支付宝
            "com.tencent.mm",                // 微信
            "com.tencent.mobileqq"           // QQ
    );

    /**
     * 判定一次动作是否需要人工确认。
     *
     * <p>取 {目标文本 + 动作类型 + 应用包名} 三者的最严结论：宁可多问一句，
     * 也不要在用户没看屏幕的时候替他决定。</p>
     */
    public Optional<DangerVerdict> inspect(String packageName, String targetText, String actionKind) {
        String text = targetText == null ? "" : targetText;
        for (String keyword : HIGH_RISK_KEYWORDS) {
            if (text.contains(keyword)) {
                return Optional.of(new DangerVerdict(
                        DangerVerdict.Risk.HIGH,
                        "目标文本命中危险关键词「" + keyword + "」"));
            }
        }

        String normalizedPackage = packageName == null ? "" : packageName.trim().toLowerCase(Locale.ROOT);
        if (MEDIUM_RISK_PACKAGES.contains(normalizedPackage)) {
            return Optional.of(new DangerVerdict(
                    DangerVerdict.Risk.MEDIUM,
                    "目标应用属于高敏应用（" + normalizedPackage + "），动作「" + safeKind(actionKind) + "」需确认"));
        }

        return Optional.empty();
    }

    private static String safeKind(String actionKind) {
        return actionKind == null || actionKind.isBlank() ? "unknown" : actionKind;
    }
}
