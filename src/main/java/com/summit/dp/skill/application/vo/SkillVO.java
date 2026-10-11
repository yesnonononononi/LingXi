package com.summit.dp.skill.application.vo;

/** Skill 清单条目：只暴露名称与描述，不回传宿主机绝对路径。 */
public record SkillVO(String name, String description) {
}
