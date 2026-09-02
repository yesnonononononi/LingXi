package com.summit.dp.workspace.api.controller;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.workspace.api.dto.WorkspaceRequest;
import com.summit.dp.workspace.application.command.WorkspaceCommand;
import com.summit.dp.workspace.application.service.WorkspaceService;
import com.summit.dp.shared.vo.WorkspaceVO;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 工作空间管理接口：创建/更新/删除/查询工作空间，供会话绑定与复用。
 */
@RestController
@RequestMapping("/workspace")
@Tag(name = "工作空间", description = "工作空间(运行环境)管理")
@RequiredArgsConstructor
public class WorkspaceController {
    private final WorkspaceService workspaceService;

    @Operation(summary = "分页列表")
    @GetMapping("/list")
    public Result<Page<WorkspaceVO>> list(Integer page, Integer pageSize) {
        return workspaceService.list(page, pageSize);
    }

    @Operation(summary = "按 id 查询")
    @GetMapping("/find/{id}")
    public Result<WorkspaceVO> findById(@PathVariable Long id) {
        return workspaceService.findById(id);
    }

    @Operation(summary = "新增工作空间")
    @PostMapping("/add")
    public Result<Long> add(@RequestBody WorkspaceRequest request) {
        return workspaceService.add(toCommand(request));
    }

    @Operation(summary = "更新工作空间")
    @PostMapping("/update")
    public Result<Void> update(@RequestBody WorkspaceRequest request) {
        return workspaceService.update(toCommand(request));
    }

    @Operation(summary = "删除工作空间")
    @GetMapping("/del")
    public Result<Void> del(Long id) {
        return workspaceService.del(id);
    }

    private WorkspaceCommand toCommand(WorkspaceRequest request) {
        return new WorkspaceCommand(request.id(), request.name(), request.type(), request.workDir(), request.containerId());
    }
}
