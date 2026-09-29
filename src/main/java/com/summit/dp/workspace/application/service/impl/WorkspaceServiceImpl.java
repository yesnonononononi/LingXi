package com.summit.dp.workspace.application.service.impl;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.workspace.application.command.WorkspaceCommand;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import com.summit.dp.workspace.domain.exception.WorkspaceNoFoundException;
import com.summit.dp.workspace.domain.model.Workspace;
import com.summit.dp.workspace.domain.repository.WorkspaceRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;



@Service
@RequiredArgsConstructor
@Slf4j
public class WorkspaceServiceImpl implements WorkspaceService {

    private final WorkspaceRepository repository;
    /** 运行目录按类型派生，类型来自单例设置，故目录推导也归转换器所有。 */
    private final WorkspaceConverter workspaceConverter;

    @Override
    public Result<Long> add(WorkspaceCommand command) {
        if (command == null) {
            throw new ClientException("请求参数不能为空");
        }
        String hostDir = trimToNull(command.hostDir());
        if (hostDir == null) {
            throw new ClientException("项目路径不能为空");
        }

        // 工作空间只登记「目录」，运行类型不落库：它由单例设置决定，
        // 在这里写死一份只会在切换模式后变成过期快照（见 Workspace 类注释）。
        String name = notBlank(command.name()) ? command.name().trim() : deriveNameFromDir(hostDir);

        Long id = repository.saveAndReturnId(new Workspace(null, name, hostDir));
        return Result.success(id);
    }

    @Override
    public Result<Void> del(Long id) {
        if (id == null) {
            throw new ClientException("workspace id 不能为空");
        }
        Workspace model = requireOwned(id);
        repository.delete(model);
        return Result.success();
    }

    @Override
    public Result<PageResult<WorkspaceVO>> list(Integer page, Integer pageSize) {
        int current = page == null || page < 1 ? 1 : page;
        int size = pageSize == null || pageSize < 1 ? 10 : pageSize;
        IPage<Workspace> entityPage = repository.queryByPage(current, size);
        PageResult<WorkspaceVO> voPage = new PageResult<>(
                entityPage.getCurrent(),
                entityPage.getSize(),
                entityPage.getTotal(),
                entityPage.getRecords().stream().map(this::toVO).toList()
        );
        return Result.success(voPage);
    }

    @Override
    public Result<WorkspaceVO> findById(Long id) {
        if (id == null) {
            throw new ClientException("id 不能为空");
        }
        // 不存在抛「工作空间不存在」，由全局处理器转 403。不返回「200 + 空 data」：
        // 那会让调用方把「不存在」读成「这个工作空间是空的」。
        return Result.success(toVO(requireOwned(id)));
    }

    /** 按 id 取工作空间；不存在抛「工作空间不存在」。 */
    private Workspace requireOwned(Long id) {
        return repository.findById(id)
                .orElseThrow(WorkspaceNoFoundException::new);
    }

    /**
     * 按宿主目录查找工作空间。
     *
     * <p><b>「未找到」不抛异常</b>，而是返回 {@code Result.success(null)}——这是本方法
     * 与 {@link #findById} 的本质区别：{@code findById} 是「按主键取资源，取不到即资源不存在」，
     * 属于错误；而本方法是「探测这个目录是否已登记」，**查不到是完全正常的业务结果**
     * （{@code CallSubAgentTool} 就依赖它落空来判定沙箱路径不可直用）。
     * 把未找到改成异常会把调用方的正常分支变成异常流。</p>
     */
    @Override
    public Result<WorkspaceVO> findByDir(String workDir) {
        if (workDir == null || workDir.isBlank()) throw new ClientException("工作目录不能为空");
        Workspace ws = repository.findByHostDir(workDir);
        return Result.success(ws == null ? null : toVO(ws));
    }


    @Override
    public Long saveModel(Workspace workspace) {
        if (workspace == null) throw new IllegalArgumentException("工作空间不能为空");
        if (workspace.getId() != null && repository.findById(workspace.getId()).isPresent()) {
            repository.updateById(workspace);
            return workspace.getId();
        }
        return repository.saveAndReturnId(workspace);
    }


    private WorkspaceVO toVO(Workspace model) {
        return WorkspaceVO.builder()
                .id(model.getId())
                .name(model.getName())
                .workDir(workspaceConverter.resolveWorkDir(model))
                .hostDir(model.getHostDir())
                .build();
    }

    private static String deriveNameFromDir(String dir) {
        if (dir == null || dir.isBlank()) {
            return "未命名项目";
        }
        String normalized = dir.replace('\\', '/');
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        int idx = normalized.lastIndexOf('/');
        if (idx >= 0 && idx < normalized.length() - 1) {
            String lastPart = normalized.substring(idx + 1).trim();
            if (!lastPart.isBlank()) {
                return lastPart;
            }
        }
        return normalized.isBlank() ? "未命名项目" : normalized.trim();
    }

    private static boolean notBlank(String value) {
        return value != null && !value.isBlank();
    }

    private static String trimToNull(String value) {
        if (value == null || value.isBlank()) {
            return value == null ? null : value.trim();
        }
        return value.trim();
    }
}
