package com.summit.dp.personalization.domain.model;

import com.summit.dp.shared.exception.ClientException;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 快捷键绑定集合：动作名 → 组合键文本。
 * <p>动作名单与默认值归前端（只有渲染层知道有哪些动作可用），后端不另存一份名单，
 * 否则新增动作要两端同时改、还会互相拒绝。这里只拦三类脏数据：动作名为空、
 * 组合为空或过长、两个动作绑到同一个组合（归一化后比较）。</p>
 */
public final class ShortcutBindings {
    /** 单个组合键文本长度上限。 */
    public static final int MAX_LENGTH = 40;

    private ShortcutBindings() {
    }

    /** 校验并返回可落盘的副本；非法输入抛 {@link ClientException}，由全局异常处理器转成用户文案。 */
    public static Map<String, String> of(Map<String, String> raw) {
        if (raw == null) throw new ClientException("快捷键配置不能为 null，清除快捷键请传空集合");
        Map<String, String> actions = new LinkedHashMap<>();
        Map<String, String> taken = new LinkedHashMap<>();
        raw.forEach((action, combo) -> {
            String name = action == null ? "" : action.trim();
            if (name.isEmpty()) throw new ClientException("快捷键动作名不能为空");
            String text = combo == null ? "" : combo.trim();
            if (text.isEmpty()) throw new ClientException("快捷键「" + name + "」不能为空");
            if (text.length() > MAX_LENGTH) {
                throw new ClientException("快捷键「" + name + "」过长，最多 " + MAX_LENGTH + " 个字符");
            }
            String previous = taken.putIfAbsent(canonical(text), name);
            if (previous != null) {
                throw new ClientException("快捷键冲突：「" + previous + "」与「" + name + "」都绑定了 " + text);
            }
            actions.put(name, text);
        });
        return actions;
    }

    /** 冲突判定用的归一形式：忽略大小写、空格与修饰键书写顺序。 */
    private static String canonical(String text) {
        List<String> tokens = new ArrayList<>();
        for (String part : text.split("\\+")) {
            tokens.add(part.trim().toLowerCase(Locale.ROOT));
        }
        Collections.sort(tokens);
        return String.join("+", tokens);
    }
}
