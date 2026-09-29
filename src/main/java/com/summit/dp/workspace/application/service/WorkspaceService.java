package com.summit.dp.workspace.application.service;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.workspace.application.command.WorkspaceCommand;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.workspace.domain.model.Workspace;

public interface WorkspaceService {

    Result<Long> add(WorkspaceCommand command);

    Result<Void> del(Long id);

    Result<PageResult<WorkspaceVO>> list(Integer page, Integer pageSize);

    /** 按 id 查工作空间；不存在时抛「工作空间不存在」（全局处理器转 403）。 */
    Result<WorkspaceVO> findById(Long id);

    /** 按宿主目录回查（本地单实例下目录即唯一键）。 */
    Result<WorkspaceVO> findByDir(String workDir);

    /** 保存由框架 WorkspaceSpec 转换得到的领域模型。 */
    Long saveModel(Workspace workspace);
}
