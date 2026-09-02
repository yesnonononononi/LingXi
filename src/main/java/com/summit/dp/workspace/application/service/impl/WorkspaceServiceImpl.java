package com.summit.dp.workspace.application.service.impl;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.workspace.application.command.WorkspaceCommand;
import com.summit.dp.workspace.application.service.WorkspaceService;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.workspace.domain.model.Workspace;
import com.summit.dp.workspace.domain.model.WorkspaceType;
import com.summit.dp.workspace.domain.repository.WorkspaceRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.nio.file.Paths;
import java.util.Optional;

/**
 * 工作空间应用服务。
 * <p>业务规则：新增默认 docker；docker 工作目录须为容器内绝对路径(以 / 开头)、容器 ID 可空；
 * local 工作目录须为主机绝对路径、不允许绑定容器；类型一旦创建不可变更。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class WorkspaceServiceImpl implements WorkspaceService {
    private final WorkspaceRepository repository;

    @Override
    public Result<Long> add(WorkspaceCommand command) {
        if (command == null) {
            return Result.error("请求参数不能为空");
        }
        if (command.workDir() == null || command.workDir().isBlank()) {
            return Result.error("工作目录 workDir 不能为空");
        }
        try {
            WorkspaceType type = parseType(command.type());
            String workDir = command.workDir().trim();
            String violation = validateWorkDir(type, workDir);
            if (violation != null) {
                return Result.error(violation);
            }
            if (type == WorkspaceType.LOCAL && notBlank(command.containerId())) {
                return Result.error("local 类型工作空间不能绑定容器ID");
            }
            String name = notBlank(command.name()) ? command.name().trim() : "工作空间";
            String containerId = type == WorkspaceType.DOCKER ? trimToNull(command.containerId()) : null;
            Workspace model = new Workspace(null, name, type, workDir, containerId);
            Long id = repository.saveAndReturnId(model);
            return id == null ? Result.error("工作空间保存失败") : Result.success(id);
        } catch (IllegalArgumentException e) {
            return Result.error(e.getMessage());
        }
    }

    @Override
    public Result<Void> update(WorkspaceCommand command) {
        if (command == null || command.id() == null) {
            return Result.error("id 不能为空");
        }
        Optional<Workspace> opt = repository.findById(command.id());
        if (opt.isEmpty()) {
            return Result.error("工作空间不存在");
        }
        Workspace model = opt.get();
        try {
            if (notBlank(command.type())) {
                WorkspaceType type = WorkspaceType.fromCode(command.type());
                if (type != model.getType()) {
                    return Result.error("工作空间类型不支持变更");
                }
            }
            if (notBlank(command.name())) {
                model.rename(command.name().trim());
            }
            if (notBlank(command.workDir())) {
                String workDir = command.workDir().trim();
                String violation = validateWorkDir(model.getType(), workDir);
                if (violation != null) {
                    return Result.error(violation);
                }
                model.changeWorkDir(workDir);
            }
            if (command.containerId() != null) {
                if (model.getType() != WorkspaceType.DOCKER) {
                    return Result.error("仅 docker 类型工作空间可绑定容器ID");
                }
                String containerId = trimToNull(command.containerId());
                if (containerId == null) {
                    return Result.error("容器ID不能为空");
                }
                model.bindContainer(containerId);
            }
        } catch (IllegalArgumentException e) {
            return Result.error(e.getMessage());
        }
        repository.updateById(model);
        return Result.success();
    }

    @Override
    public Result<Void> del(Long id) {
        if (id == null) {
            return Result.error("id 不能为空");
        }
        Optional<Workspace> opt = repository.findById(id);
        if (opt.isEmpty()) {
            return Result.error("工作空间不存在");
        }
        repository.delete(opt.get());
        return Result.success();
    }

    @Override
    public Result<Page<WorkspaceVO>> list(Integer page, Integer pageSize) {
        int current = page == null || page < 1 ? 1 : page;
        int size = pageSize == null || pageSize < 1 ? 10 : pageSize;
        Page<Workspace> entityPage = (Page<Workspace>) repository.queryByPage(current, size);
        Page<WorkspaceVO> voPage = new Page<>(entityPage.getCurrent(), entityPage.getSize(), entityPage.getTotal());
        voPage.setRecords(entityPage.getRecords().stream().map(this::toVO).toList());
        return Result.success(voPage);
    }

    @Override
    public Result<WorkspaceVO> findById(Long id) {
        if (id == null) {
            return Result.error("id 不能为空");
        }
        return repository.findById(id)
                .map(m -> Result.success(toVO(m)))
                .orElseGet(() -> Result.error("工作空间不存在"));
    }

    private WorkspaceVO toVO(Workspace model) {
        return WorkspaceVO.builder()
                .id(model.getId())
                .name(model.getName())
                .type(model.getType() == null ? null : model.getType().code())
                .workDir(model.getWorkDir())
                .containerId(model.getContainerId())
                .build();
    }

    private WorkspaceType parseType(String code) {
        if (!notBlank(code)) {
            return WorkspaceType.DOCKER;
        }
        return WorkspaceType.fromCode(code);
    }

    /**
     * @return 违规描述；合规返回 null
     */
    private String validateWorkDir(WorkspaceType type, String workDir) {
        if (type == WorkspaceType.DOCKER) {
            return workDir.startsWith("/") ? null : "docker 类型工作目录须为容器内绝对路径(以 / 开头)";
        }
        return Paths.get(workDir).isAbsolute() ? null : "local 类型工作目录须为主机绝对路径";
    }

    private static boolean notBlank(String value) {
        return value != null && !value.isBlank();
    }

    private static String trimToNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        return value.trim();
    }
}
