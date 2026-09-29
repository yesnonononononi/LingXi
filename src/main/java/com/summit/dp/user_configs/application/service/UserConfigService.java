package com.summit.dp.user_configs.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.user_configs.application.command.UserConfigCommand;
import com.summit.dp.user_configs.application.vo.UserConfigVO;

/**
 * UserConfig 应用层服务接口。
 *
 * <p><b>本地单实例（HC-1）</b>：设置是「进程级单例」而不是「每个用户一份」，
 * 读写入口都不再带用户参数；内部按 {@code LocalInstance.SETTINGS_ROW_ID} 定位唯一行。</p>
 */
public interface UserConfigService {

    /** 当前实例的通用配置（工作空间类型等）；无配置行时建默认行并返回。 */
    Result<UserConfigVO> current();

    /** 更新当前实例的通用配置（无需传 id，服务端按单例行定位）。 */
    Result<Void> update(UserConfigCommand command);
}
