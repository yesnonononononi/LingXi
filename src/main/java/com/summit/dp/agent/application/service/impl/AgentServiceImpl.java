package com.summit.dp.agent.application.service.impl;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.runtime.Workspace;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.session.application.command.SessionCommand;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.workspace.application.command.WorkspaceCommand;
import com.summit.dp.workspace.application.service.WorkspaceService;
import com.summit.dp.workspace.domain.model.WorkspaceType;
import com.summit.dp.workspace.domain.repository.WorkspaceRepository;
import com.summit.dp.workspace.infrastructure.converter.FrameworkWorkspaceAssembler;
import com.summit.runtime.agent.ChatAgent;
import com.summit.runtime.sandbox.DockerWorkspace;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;

import java.nio.file.Paths;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;


/**
 * 会话聊天编排：负责“会话 → 工作空间（运行环境）”的解析与续接。
 *
 * <p>工作空间解析优先级：请求显式 {@code workspaceId} → 会话已绑定的 workspaceId
 * （续聊复用其容器/目录）→ 自动新建（docker 起新容器并回填 containerId、local 直接用目录），
 * 新建后绑定回会话，保证后续轮次走“续接”分支。</p>
 */
@RequiredArgsConstructor
@Service
@Slf4j
public class AgentServiceImpl implements AgentService {
    /** docker 类型未显式指定目录时的容器内默认工作目录 */
    private static final String DEFAULT_DOCKER_WORKDIR = "/workspace";

    private final ChatAgent chatAgent;
    private final SseEventPublisher sseEventPublisher;
    private final SessionService sessionService;
    private final WorkspaceService workspaceService;
    private final WorkspaceRepository workspaceRepository;
    private final FrameworkWorkspaceAssembler frameworkWorkspaceAssembler;

    @Value("${lingxi.agent.workspace:docker}")
    private String defaultWorkspaceType;


    @Override
    public Result<String> chat(ChatCommand command) {
        RuntimeContext context = prepare(command);
        Execution execution = chatAgent.execute(buildRequest(command.input(), false, context));
        return Result.success(execution.getMessages().toString());
    }

    @Override
    public SseEmitter chatStream(ChatCommand command) {
        SseEmitter sseEmitter = sseEventPublisher.connect();
        RuntimeContext context = prepare(command);
        chatAgent.execute(buildRequest(command.input(), true, context));
        return sseEmitter;
    }

    /**
     * 编排上下文：解析出的会话与其可用的运行环境。
     */
    private record RuntimeContext(SessionVO session, Workspace workspace) {
    }

    /**
     * 1) 确保会话存在；2) 解析/创建并绑定工作空间。
     */
    private RuntimeContext prepare(ChatCommand command) {
        SessionVO session = ensureSession(command.sessionId());
        Long workspaceId = command.workspaceId() != null ? command.workspaceId() : session.getWorkspaceId();
        Workspace workspace = resolveWorkspace(session, workspaceId, command.workDir());
        return new RuntimeContext(session, workspace);
    }

    /**
     * 会话不存在（或 id 无效）时按“新对话”创建并返回其最新视图。
     */
    private SessionVO ensureSession(Long sessionId) {
        if (sessionId != null) {
            SessionVO session = sessionService.findById(sessionId).getData();
            if (session != null) {
                return session;
            }
        }
        Long id = sessionService.add(new SessionCommand(null, "新对话", null)).getData();
        if (id == null) {
            throw new ClientException("创建会话失败");
        }
        SessionVO session = sessionService.findById(id).getData();
        if (session == null) {
            throw new ClientException("会话创建后无法读取");
        }
        return session;
    }

    /**
     * 解析工作空间：
     * <ul>
     *   <li>指定了 workspaceId（显式或会话绑定）→ 续接已有运行环境；</li>
     *   <li>否则 → 新建工作空间并绑定到会话。</li>
     * </ul>
     */
    private Workspace resolveWorkspace(SessionVO session, Long workspaceId, String workDir) {
        if (workspaceId != null) {
            return attachBoundWorkspace(workspaceId);
        }
        return createWorkspaceAndBind(session, workDir);
    }

    /**
     * 续接已有工作空间：docker 复用已存容器（containerId 未回填时补起容器），local 直接装配目录。
     */
    private Workspace attachBoundWorkspace(Long workspaceId) {
        com.summit.dp.workspace.domain.model.Workspace domain = workspaceRepository.findById(workspaceId).orElse(null);
        if (domain == null) {
            throw new ClientException("工作空间不存在: " + workspaceId);
        }
        if (domain.getType() == WorkspaceType.DOCKER
                && (domain.getContainerId() == null || domain.getContainerId().isBlank())) {
            log.info("Workspace {} has no container yet, provisioning one", workspaceId);
            return provisionDocker(domain.getId().toString(), domain.getWorkDir());
        }
        Workspace framework = frameworkWorkspaceAssembler.toFramework(domain);
        if (framework == null) {
            throw new ClientException("工作空间不可用: " + workspaceId + "（请检查类型与容器状态）");
        }
        return framework;
    }

    /**
     * 新建工作空间并绑定到会话：先落库（docker 无容器），docker 起容器后回填 containerId。
     */
    private Workspace createWorkspaceAndBind(SessionVO session, String workDir) {
        boolean docker = isDefaultDocker();
        String effectiveWorkDir = normalizeWorkDir(workDir, docker);
        Long workspaceId = workspaceService.add(new WorkspaceCommand(
                null, "工作空间", docker ? "docker" : "local", effectiveWorkDir, null)).getData();
        if (workspaceId == null) {
            throw new ClientException("工作空间创建失败");
        }
        try {
            Workspace framework;
            if (docker) {
                framework = provisionDocker(workspaceId.toString(), effectiveWorkDir);
            } else {
                com.summit.dp.workspace.domain.model.Workspace domain = workspaceRepository.findById(workspaceId)
                        .orElseThrow(() -> new IllegalStateException("刚创建的工作空间查询不到: " + workspaceId));
                framework = frameworkWorkspaceAssembler.toFramework(domain);
                if (framework == null) {
                    throw new IllegalStateException("工作空间装配失败: " + workspaceId);
                }
            }
            // 绑定失败会抛异常（会话不存在/工作空间不可用），由下方 catch 回滚刚建的工作空间
            sessionService.bindWorkspace(session.getId(), workspaceId);
            return framework;
        } catch (Exception e) {
            try {
                workspaceService.del(workspaceId);
            } catch (Exception cleanup) {
                log.warn("Cleanup workspace {} failed: {}", workspaceId, cleanup.toString());
            }
            throw e instanceof ClientException ce ? ce : new ClientException("工作空间初始化失败: " + e.getMessage());
        }
    }

    /**
     * 起 docker 容器并回填 containerId；容器名固定 ws-{workspaceId}，便于排查与清理。
     */
    private Workspace provisionDocker(String workspaceId, String workDir) {
        DockerWorkspace docker;
        try {
            docker = DockerWorkspace.newInstance(workspaceId, workDir, "ws-" + workspaceId, null);
        } catch (Exception e) {
            throw new ClientException("Docker 工作空间初始化失败: " + e.getMessage());
        }
        try {
            workspaceService.update(new WorkspaceCommand(
                    Long.valueOf(workspaceId), null, null, null, docker.getContainerId()));
        } catch (Exception e) {
            log.warn("Persist container {} for workspace {} failed: {}",
                    docker.getContainerId(), workspaceId, e.toString());
        }
        return docker;
    }

    private boolean isDefaultDocker() {
        return defaultWorkspaceType == null || defaultWorkspaceType.isBlank()
                || "docker".equalsIgnoreCase(defaultWorkspaceType.trim());
    }

    /**
     * 归一化工作目录：docker 缺省容器内 /workspace；local 必须显式提供主机绝对路径。
     */
    private String normalizeWorkDir(String workDir, boolean docker) {
        if (workDir == null || workDir.isBlank()) {
            if (docker) {
                return DEFAULT_DOCKER_WORKDIR;
            }
            throw new ClientException("local 类型工作空间需要指定主机工作目录 workDir");
        }
        String dir = workDir.trim();
        if (docker && !dir.startsWith("/")) {
            throw new ClientException("docker 工作目录须为容器内绝对路径(以 / 开头)");
        }
        if (!docker && !Paths.get(dir).isAbsolute()) {
            throw new ClientException("local 工作目录须为主机绝对路径");
        }
        return dir;
    }

    private AgentRequest buildRequest(String prompt, boolean isStreaming, RuntimeContext context) {
        return AgentRequest
                .builder()
                .sessionId(context.session().getId())
                .input(prompt)
                .sessionName(context.session().getName())
                .streaming(isStreaming)
                .workspace(context.workspace())
                .build();
    }
}
