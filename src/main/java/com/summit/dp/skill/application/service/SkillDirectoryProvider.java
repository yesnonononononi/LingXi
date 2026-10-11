package com.summit.dp.skill.application.service;

import java.nio.file.Path;

/** 查询与执行共用已就绪目录，避免 Skill 模块反向依赖执行编排。 */
public interface SkillDirectoryProvider {
    Path root();
}
