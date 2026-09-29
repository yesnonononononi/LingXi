package com.summit.dp.shared.settings;

import com.summit.dp.shared.context.SettingsView;

import java.util.Optional;

/** 单例本地设置的只读视图，供需要「读一项设置」的基础设施类使用。 */
public interface SettingsProvider {

    /**
     * 当前生效的单例设置。
     *
     * @return 设置视图；实现方在无设置行时应返回默认视图而非 empty，
     *         empty 仅在底层读取异常等不可恢复场景出现
     */
    Optional<SettingsView> current();
}
