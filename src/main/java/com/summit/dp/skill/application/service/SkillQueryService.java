package com.summit.dp.skill.application.service;

import com.summit.core.conf.SkillConfig;
import com.summit.core.skill.SkillLoader;
import com.summit.dp.skill.application.vo.SkillVO;
import com.summit.dp.workflow.infrastructure.policy.SkillRootResolver;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.util.List;

/**
 * Skill 清单查询：给前端的 /skill 面板与自动补全用。
 *
 * <p>直接复用框架已装配的 {@link SkillLoader}（本地环境即 {@code FileSystemSkillLoader}），
 * 与执行侧同一条解析链路，目录里新增 SKILL.md 无需重启即可见。</p>
 */
@Service
@RequiredArgsConstructor
public class SkillQueryService {

    private final SkillLoader skillLoader;
    private final SkillRootResolver skillRootResolver;

    /**
     * 列出当前生效的全部 Skill。
     *
     * <p>Skill 能力关闭（根目录未配置或不可用）时返回空清单而不是报错：
     * Skill 是可选能力，前端据此隐藏入口，不能因为一个开关让面板 500。</p>
     */
    public List<SkillVO> listSkills() {
        Path root = skillRootResolver.root();
        if (root == null) {
            return List.of();
        }
        return skillLoader.load(new SkillConfig(root)).stream()
                .map(skill -> new SkillVO(skill.name(), skill.description()))
                .toList();
    }
}
