package com.summit.dp.workspace.application.service;

import com.summit.dp.workspace.application.vo.SandboxServiceStatus;

/** 检查运行资源，不承担系统组件安装。 */
public interface SandboxService {
    SandboxServiceStatus inspect();
    SandboxServiceStatus check();
}
