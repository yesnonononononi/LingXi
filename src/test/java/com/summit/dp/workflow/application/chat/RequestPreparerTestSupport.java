package com.summit.dp.workflow.application.chat;

import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.execution.application.service.RuntimeConfigurationService;
import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.personalization.domain.repository.PersonalizationRepository;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.tools.ToolListProcessorTestSupport;
import com.summit.dp.tools.application.service.ToolListProcessor;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.dp.workflow.infrastructure.policy.SkillRootResolver;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;

import java.util.List;
import java.util.Optional;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * {@link RequestPreparer} 的测试侧构造器（命名参数化）。
 *
 * <p><b>为什么必须有它：</b>{@code RequestPreparer} 是 Lombok {@code @RequiredArgsConstructor}，
 * 19 个必填依赖只能按位置传。历史上测试直接写
 * {@code new RequestPreparer(null, mock(...), null, null, null, null, ...)} —— 只要有人新增一个
 * 同类型字段、或调整两个字段顺序，编译器一句话都不会说，运行期才在某条分支上炸成 NPE
 * （{@code RuntimeConfigurationIntegrationTest} 的 {@code settingsProvider} 就是这么变成 null 的：
 * 参数个数没变，第 6 位一直是 null，字段却早就成了必填）。</p>
 *
 * <p><b>用法：</b>只覆盖本次用例真正关心的依赖，其余走安全默认（互相独立的 Mockito 桩 +
 * 「无设置行」的默认设置视图）。默认值集中在构造函数里，只在一处维护。</p>
 *
 * <p><b>装配点唯一：</b>整个测试源码树里只允许本类（{@code RequestPreparerTestSupport}）执行位置参数装配；
 * {@code RequestPreparerConstructionRatchetTest} 会扫描 {@code src/test/java} 守住这条，
 * 新增构造点要么改用本 builder，要么显式改基线（改基线这件事本身就在评审视野里）。</p>
 */
public final class RequestPreparerTestSupport {

    /**
     * 「无设置行」时的默认设置视图。
     *
     * <p>{@link SettingsProvider#current()} 的契约是<b>返回默认视图而不是 empty</b>
     * （empty 只留给读取异常），所以这里给一个各字段全 null 的视图：调用方各自走缺省。
     * {@code teamSize} 按契约不会为 null，且本类不读取它，取值只需非空。</p>
     */
    private static final SettingsView DEFAULT_SETTINGS =
            new SettingsView(null, null, null, null, null, null, null, null, null, 1);

    private SessionService sessionService;
    private SessionRepository sessionRepository;
    private WorkspaceService workspaceService;
    private ModelService modelService;
    private WorkspaceConverter workspaceConverter;
    private SettingsProvider settingsProvider;
    private ToolListProcessor toolListProcessor;
    private ConversationTranscriptService transcriptService;
    private ModelContextService modelContextService;
    private ChatTurnService chatTurnService;
    private AgentService agentService;
    private TeamService teamService;
    private McpService mcpService;
    private SkillRootResolver skillRootResolver;
    private ChatImageResolver chatImageResolver;
    private BusinessSystemPromptBuilder systemPromptBuilder;
    private PersonalizationRepository personalizationRepository;
    private RuntimeConfigurationService runtimeConfigurations;
    private List<MemoryLoader> memoryLoaders;

    private RequestPreparerTestSupport() {
        this.sessionService = mock(SessionService.class);
        this.sessionRepository = mock(SessionRepository.class);
        this.workspaceService = mock(WorkspaceService.class);
        this.modelService = mock(ModelService.class);
        this.workspaceConverter = mock(WorkspaceConverter.class);
        SettingsProvider provided = mock(SettingsProvider.class);
        when(provided.current()).thenReturn(Optional.of(DEFAULT_SETTINGS));
        this.settingsProvider = provided;
        this.toolListProcessor = ToolListProcessorTestSupport.create();
        this.transcriptService = mock(ConversationTranscriptService.class);
        this.modelContextService = mock(ModelContextService.class);
        this.chatTurnService = mock(ChatTurnService.class);
        this.agentService = mock(AgentService.class);
        this.teamService = mock(TeamService.class);
        this.mcpService = mock(McpService.class);
        this.skillRootResolver = new SkillRootResolver("");
        this.chatImageResolver = new ChatImageResolver();
        this.systemPromptBuilder = new BusinessSystemPromptBuilder("");
        this.personalizationRepository = mock(PersonalizationRepository.class);
        this.runtimeConfigurations = mock(RuntimeConfigurationService.class);
        this.memoryLoaders = List.of();
    }

    /**
     * 开一个 builder。
     *
     * @return 已装好安全默认值的 builder
     */
    public static RequestPreparerTestSupport builder() {
        return new RequestPreparerTestSupport();
    }

    public RequestPreparerTestSupport sessionService(SessionService value) {
        this.sessionService = value;
        return this;
    }

    public RequestPreparerTestSupport sessionRepository(SessionRepository value) {
        this.sessionRepository = value;
        return this;
    }

    public RequestPreparerTestSupport workspaceService(WorkspaceService value) {
        this.workspaceService = value;
        return this;
    }

    public RequestPreparerTestSupport modelService(ModelService value) {
        this.modelService = value;
        return this;
    }

    public RequestPreparerTestSupport workspaceConverter(WorkspaceConverter value) {
        this.workspaceConverter = value;
        return this;
    }

    public RequestPreparerTestSupport settingsProvider(SettingsProvider value) {
        this.settingsProvider = value;
        return this;
    }

    public RequestPreparerTestSupport toolListProcessor(ToolListProcessor value) {
        this.toolListProcessor = value;
        return this;
    }

    public RequestPreparerTestSupport transcriptService(ConversationTranscriptService value) {
        this.transcriptService = value;
        return this;
    }

    public RequestPreparerTestSupport modelContextService(ModelContextService value) {
        this.modelContextService = value;
        return this;
    }

    public RequestPreparerTestSupport chatTurnService(ChatTurnService value) {
        this.chatTurnService = value;
        return this;
    }

    public RequestPreparerTestSupport agentService(AgentService value) {
        this.agentService = value;
        return this;
    }

    public RequestPreparerTestSupport teamService(TeamService value) {
        this.teamService = value;
        return this;
    }

    public RequestPreparerTestSupport mcpService(McpService value) {
        this.mcpService = value;
        return this;
    }

    public RequestPreparerTestSupport skillRootResolver(SkillRootResolver value) {
        this.skillRootResolver = value;
        return this;
    }

    public RequestPreparerTestSupport chatImageResolver(ChatImageResolver value) {
        this.chatImageResolver = value;
        return this;
    }

    public RequestPreparerTestSupport systemPromptBuilder(BusinessSystemPromptBuilder value) {
        this.systemPromptBuilder = value;
        return this;
    }

    public RequestPreparerTestSupport personalizationRepository(PersonalizationRepository value) {
        this.personalizationRepository = value;
        return this;
    }

    public RequestPreparerTestSupport runtimeConfigurations(RuntimeConfigurationService value) {
        this.runtimeConfigurations = value;
        return this;
    }

    public RequestPreparerTestSupport memoryLoaders(List<MemoryLoader> value) {
        this.memoryLoaders = value;
        return this;
    }

    /**
     * 装配被测对象。
     *
     * <p>这是整个测试源码树里<b>唯一</b>一处按位置传参的地方：字段顺序若变化，
     * 参数类型不匹配会在这里编译失败；同类型相邻字段被换序则依赖
     * {@code RequestPreparerConstructionRatchetTest} 与本注释逐位标注。</p>
     *
     * @return 已装配的 RequestPreparer
     */
    public RequestPreparer build() {
        return new RequestPreparer(
                sessionService,              // 1  sessionService
                sessionRepository,           // 2  sessionRepository
                workspaceService,            // 3  workspaceService
                modelService,                // 4  modelService
                workspaceConverter,          // 5  workspaceConverter
                settingsProvider,            // 6  settingsProvider   ← 曾经被传成 null 的那个
                toolListProcessor,           // 7  toolListProcessor
                transcriptService,           // 8  transcriptService
                modelContextService,         // 9  modelContextService
                chatTurnService,             // 10 chatTurnService
                agentService,                // 11 agentService
                teamService,                 // 12 teamService
                mcpService,                  // 13 mcpService
                skillRootResolver,           // 14 skillRootResolver
                chatImageResolver,           // 15 chatImageResolver
                systemPromptBuilder,         // 16 systemPromptBuilder
                personalizationRepository,   // 17 personalizationRepository
                runtimeConfigurations,      // 18 runtimeConfigurations
                memoryLoaders);              // 19 memoryLoaders
    }
}
