package com.summit.dp.user_configs.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.user_configs.domain.model.UserConfig;

import java.util.Optional;

/** UserConfig 领域仓储。本地单实例（HC-1）：配置只有一行，按主键定位。 */
public interface UserConfigRepository extends RepositoryTemplate<UserConfig, Long> {

    /** 读取唯一设置行（主键 = LocalInstance.SETTINGS_ROW_ID）；无行时返回 empty。 */
    Optional<UserConfig> findSingleton();
}
