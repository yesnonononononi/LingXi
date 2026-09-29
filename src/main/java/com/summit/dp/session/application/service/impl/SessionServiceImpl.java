package com.summit.dp.session.application.service.impl;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import cn.hutool.core.util.IdUtil;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.command.SessionCommand;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.TokenUsage;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.model.CursorResult;
import com.summit.dp.shared.vo.SessionMessagePageVO;
import com.summit.dp.shared.vo.SessionMessageVO;
import com.summit.dp.shared.vo.SessionTreeVO;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.workspace.application.service.WorkspaceService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 会话应用服务。
 *
 * <p><b>本地单实例（HC-1）</b>：没有账号归属，会话的可见性由「知道 id」承载，
 * 读路径一律按主键直查。工作空间绑定时机不变：仅在 {@link #initialize} 创建时确定。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class SessionServiceImpl implements SessionService {
    private static final int SESSION_NAME_MAX_CODE_POINTS = 20;
    private final SessionAggregateService sessionAggregateService;
    private final WorkspaceService workspaceService;
    private final SessionRepository sessionRepository;
    private final SessionMessageQueryService messageQueryService;
    /**
     * 执行查询服务：读侧唯一入口，批量取会话的执行状态列表用于展示状态组合。
     * 会话不持有执行状态，展示状态一律经此服务查询时组合（见 2026-09 状态技术债设计）。
     */
    private final ExecutionQueryService executionQueryService;
    /** 团队校验入口：换绑前确认目标团队存在，避免把会话挂到一个查不到的团队上。 */
    private final TeamService teamService;

    @Override
    public Result<Long> initialize(String input, Long workspaceId, Long teamId) {
        if (input == null || input.isBlank()) throw new ClientException("聊天内容不能为空");
        // 工作空间由 findById 校验存在性；不存在直接抛「工作空间不存在」，
        // 不会出现「用无效 workspaceId 建会话」的悬挂绑定。
        if (workspaceId != null) workspaceService.findById(workspaceId);
        Session session = Session.builder().id(IdUtil.getSnowflakeNextId())
                .name(toSessionName(input))
                .workspaceId(workspaceId)
                // 首轮团队绑定；null=非团队会话。此后可经 bindTeam 换绑（团队不持有宿主机路径，
                // 与 workspaceId 的「创建即固定」不是一回事）。
                .teamId(teamId)
                .tokenUsage(TokenUsage.empty())
                .build();
        return Result.success(sessionAggregateService.save(session));
    }

    private String toSessionName(String input) {
        String normalized = input.strip().replaceAll("\\s+", " ");
        int end = normalized.offsetByCodePoints(0,
                Math.min(normalized.codePointCount(0, normalized.length()), SESSION_NAME_MAX_CODE_POINTS));
        return normalized.substring(0, end);
    }

    @Override
    public Result<Void> update(SessionCommand command) {
        if (command == null || command.id() == null) throw new ClientException("会话ID不能为空");
        // requireOwned 查不到会抛「会话不存在」。工作空间不在本方法可改范围内（见类注释）。
        Session session = sessionAggregateService.requireOwned(command.id());
        if (command.name() != null && !command.name().isBlank()) session.rename(command.name());
        sessionAggregateService.save(session);
        return Result.success();
    }

    /**
     * 换绑协作团队：前端团队下拉框的选中即写入此处。
     *
     * <p>拒绝运行中换绑——本轮编排身份已在执行快照里固化，中途换绑会造成
     * 「本轮按旧队跑、恢复后按新队跑」。挂起态允许：挂起的执行尚未固化下一段编排，
     * 恢复前换绑可让用户改主意（前提是先处理完待审批卡片）。</p>
     */
    @Override
    public Result<Void> bindTeam(Long sessionId, Long teamId) {
        if (sessionId == null) throw new ClientException("会话ID不能为空");
        Session session = sessionAggregateService.requireOwned(sessionId);
        if (teamId != null) requireTeam(teamId);
        session.changeTeam(teamId);
        sessionAggregateService.save(session);
        return Result.success();
    }

    /** 团队存在性校验：换绑到一个不存在的团队会让后续编排在指挥者回落处才报错，提前拦下更清晰。 */
    private void requireTeam(Long teamId) {
        TeamVO team = teamService.findById(teamId).getData();
        if (team == null) throw new ClientException("未找到指定的团队: " + teamId);
    }

    @Override
    public Result<Void> del(Long id) {
        sessionAggregateService.deleteById(id);
        return Result.success();
    }

    @Override
    public Result<PageResult<SessionVO>> list(Integer page, Integer pageSize) {
        int current = page == null || page < 1 ? 1 : page;
        int size = pageSize == null || pageSize < 1 ? 10 : Math.min(pageSize, 100);
        Page<Session> source = sessionAggregateService.page(current, size);
        // 一次 IN 批量取执行状态列表，逐会话组合展示状态（避免逐条查询）。
        Map<Long, List<ExecutionState>> statesBySession = executionQueryService.latestStatesBySession(
                source.getRecords().stream().map(Session::getId).toList());
        PageResult<SessionVO> result = new PageResult<>(
                source.getCurrent(),
                source.getSize(),
                source.getTotal(),
                source.getRecords().stream()
                        .map(session -> toVO(session, statesBySession.get(session.getId()), null))
                        .toList()
        );
        return Result.success(result);
    }

    @Override
    public Result<SessionVO> findById(Long id) {
        // 查不到即抛「会话不存在」（全局处理器转 403），不回 200 + null：
        // 那会让调用方把「不存在」读成「这个会话是空的」。
        Session session = sessionAggregateService.requireOwned(id);
        return Result.success(toVO(session, executionQueryService.latestStatesBySession(List.of(id)).get(id), null));
    }

    @Override
    public Result<SessionMessagePageVO> messages(Long sessionId, String cursor, Integer size) {
        if (sessionId == null) throw new ClientException("会话ID不能为空");

        // 先确认会话存在，再取一页消息。
        sessionAggregateService.requireOwned(sessionId);

        CursorResult<SessionMessage> slice = sessionAggregateService.messageSlice(sessionId, cursor, size);

        // 转换 + 一次 IN 批量挂载工具调用（单页 tool_call 查询恒为 1 次）：二者在 query() 内显式串联，杜绝漏调。
        SessionMessageQueryService.SessionMessageQueryResult loaded = messageQueryService.query(slice.records());

        return Result.success(SessionMessagePageVO.builder()
                .records(loaded.records())
                .toolCallCount(loaded.toolCallCount())
                .nextCursor(slice.nextCursor())
                .hasMore(slice.hasMore())
                .build());
    }

    @Override
    public Result<SessionTreeVO> tree(Long sessionId) {
        if (sessionId == null) throw new ClientException("会话ID不能为空");
        SessionAggregateService.SessionTree tree = sessionAggregateService.sessionTree(sessionId);
        List<Session> sessions = tree.sessions();
        List<Long> ids = sessions.stream().map(Session::getId).toList();
        Map<Long, Long> counts = sessionAggregateService.countMessages(ids);
        // 执行状态列表与消息条数同为「一次 IN 批量取」，逐会话组合。
        Map<Long, List<ExecutionState>> statesBySession = executionQueryService.latestStatesBySession(ids);
        return Result.success(SessionTreeVO.builder()
                .rootSessionId(tree.rootSessionId())
                .sessions(sessions.stream()
                        .map(session -> toVO(session, statesBySession.get(session.getId()),
                                counts.getOrDefault(session.getId(), 0L)))
                        .toList())
                .build());
    }

    /**
     * 工作空间与会话的绑定只发生在创建那一刻，此后不可变。
     *
     * <p>保留本方法仅为兼容接口签名，一律拒绝：绑定时机若允许出现在创建之后，
     * 就等于给「换一个工作空间」留了后门 —— 会话已有消息时改 workspace 会让历史
     * 消息与新工作目录对不上，而 workspace 的 hostDir 又是宿主机绝对路径，
     * 后置改写等于把会话引到另一个目录去执行。</p>
     */
    @Override
    public Result<Void> bindWorkspace(Long sessionId, Long workspaceId) {
        throw new ClientException("工作空间与会话的绑定在创建时确定，不支持后续变更");
    }

    /**
     * 会话视图。{@code workspaceId} 为 null 表示「这个会话没有工作空间」，是合法状态
     * （创建时可以不选），因此不能去查工作空间 —— 那样会变成「拿 null 查实体」。
     * 查回来为空同样按「无工作空间」处理：只影响 workDir 这一展示字段，
     * 不该让整个会话读取失败。
     *
     * <p>展示状态（{@code runStatus}/{@code lastOutcome}）由执行状态列表组合而来，
     * 而非会话自身字段——会话不持有执行状态。</p>
     */
    private SessionVO toVO(Session session, List<ExecutionState> states, Long messageCount) {
        WorkspaceVO workspace = workspaceOrDefault(session.getWorkspaceId());

        TokenUsage usage = session.getTokenUsage() == null ? TokenUsage.empty() : session.getTokenUsage();
        return SessionVO.builder().id(session.getId()).name(session.getName())
                .runStatus(runStatusOf(states))
                .lastOutcome(lastOutcomeOf(states))
                .agentId(session.getAgentId())
                .rootSessionId(session.getRootSessionId()).createTime(session.getCreateTime())
                .updateTime(session.getUpdateTime())
                .workspaceId(session.getWorkspaceId())
                .teamId(session.getTeamId())
                .workDir(workspace == null ? null : workspace.workDir())
                .totalTokens(usage.totalTokens()).inputTokens(usage.inputTokens()).outputTokens(usage.outputTokens())
                .messageCount(messageCount)
                .build();

    }

    /**
     * 进行中状态出参（唯一组合点）：由执行状态列表映射为词表 {@code IDLE | RUNNING | SUSPENDED}。
     *
     * <p>缺省（无执行 / 状态列表缺失 / 无进行中状态）输出 {@code IDLE}，前端免判空。
     * {@code CREATED} 归并入 {@code RUNNING}：对展示层无区分意义。</p>
     */
    private static String runStatusOf(List<ExecutionState> states) {
        if (states == null) return "IDLE";
        for (ExecutionState state : states) {
            switch (state) {
                case CREATED, RUNNING: return "RUNNING";
                case SUSPENDED: return "SUSPENDED";
                case COMPLETED, FAILED, CANCELLED: break;
            }
        }
        return "IDLE";
    }

    /** 最近终态与进行态独立选择，二者可以同时存在。 */
    private static String lastOutcomeOf(List<ExecutionState> states) {
        if (states == null) return null;
        for (ExecutionState state : states) {
            switch (state) {
                case COMPLETED, FAILED, CANCELLED: return state.name();
                case CREATED, RUNNING, SUSPENDED: break;
            }
        }
        return null;
    }

    /**
     * 按 id 取工作空间用于视图装配；id 为空返回 null（「该会话没有工作空间」是合法状态）。
     *
     * <p>会话本身已解析过，这里的失败只影响 workDir 这一个展示字段，
     * 不该让整个会话读取失败，所以吞掉异常返回 null。</p>
     */
    private WorkspaceVO workspaceOrDefault(Long workspaceId) {
        if (workspaceId == null) return null;
        try {
            return workspaceService.findById(workspaceId).getData();
        } catch (RuntimeException e) {
            log.warn("会话关联的工作空间 {} 无法解析，workDir 置空: {}", workspaceId, e.getMessage());
            return null;
        }
    }
}
