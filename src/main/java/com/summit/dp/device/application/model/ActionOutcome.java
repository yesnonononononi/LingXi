package com.summit.dp.device.application.model;

/**
 * 一次动作的结果。
 *
 * <p>失败必须带可读原因：agent 拿不到原因就只能瞎重试，而"瞎重试"在真实设备上等于乱点。</p>
 */
public record ActionOutcome(
        String actionId,
        boolean ok,
        String errorCode,
        String errorMessage,
        Integer idleMs,
        Boolean screenChanged,
        String frameHash
) {

    public static ActionOutcome success(String actionId, Integer idleMs, Boolean changed, String frameHash) {
        return new ActionOutcome(actionId, true, null, null, idleMs, changed, frameHash);
    }

    public static ActionOutcome failure(String actionId, String errorCode, String errorMessage) {
        return new ActionOutcome(actionId, false, errorCode, errorMessage, null, null, null);
    }

    public String toPromptText() {
        if (ok) {
            return "ok action=" + actionId
                    + (frameHash == null ? "" : " frame=" + frameHash)
                    + (idleMs == null ? "" : " idleMs=" + idleMs)
                    + (screenChanged == null ? "" : " changed=" + screenChanged);
        }
        return "failed action=" + actionId + " code=" + errorCode + " reason=" + errorMessage;
    }
}
