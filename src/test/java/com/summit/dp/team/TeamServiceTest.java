package com.summit.dp.team;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.domain.model.Agent;
import com.summit.dp.team.api.controller.TeamController;
import com.summit.dp.team.api.request.TeamRequest;
import com.summit.dp.team.application.command.TeamCommand;
import com.summit.dp.team.application.service.impl.TeamServiceImpl;
import com.summit.dp.team.application.service.impl.TeamValidator;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.team.domain.model.Team;
import com.summit.dp.team.domain.repository.TeamRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Team 模块核心能力单测：
 * 验证对齐后团队描述字段的入参拷贝、业务校验、模型更新、视图对象映射与删除功能。
 */
class TeamServiceTest {

    private TeamRepository repository;
    private AgentService agentService;
    private TeamValidator validator;
    private TeamServiceImpl service;
    private TeamController controller;

    @BeforeEach
    void setUp() {
        repository = mock(TeamRepository.class);
        agentService = mock(AgentService.class);
        validator = new TeamValidator(agentService);
        ReflectionTestUtils.setField(validator, "maxMemberSize", 10);
        service = new TeamServiceImpl(repository, validator, agentService);
        controller = new TeamController(service);
    }

    private AgentVO createAgent(Long id, String name) {
        AgentVO agent = new AgentVO();
        agent.setId(id);
        agent.setName(name);
        agent.setStatus(Agent.STATUS_ENABLED);
        agent.setToolList(List.of());
        return agent;
    }

    @Test
    @DisplayName("校验器校验：创建团队时描述超长报错，正常描述通过")
    void testValidatorCreateDescription() {
        when(agentService.queryIn(anyList())).thenReturn(Result.success(List.of(
                createAgent(1L, "Leader"),
                createAgent(2L, "Worker")
        )));

        TeamCommand command = new TeamCommand();
        command.setName("研发协同团队");
        command.setCommanderAgentId(1L);
        command.setAgentIds(List.of(1L, 2L));
        command.setDescription("a".repeat(Team.MAX_DESCRIPTION_LENGTH + 1));

        String error = validator.validateForCreate(command);
        assertNotNull(error);
        assertTrue(error.contains("团队描述长度不能超过"));

        command.setDescription("这是一个合法的团队描述，明确团队分工与职责。");
        String pass = validator.validateForCreate(command);
        assertNull(pass);
    }

    @Test
    @DisplayName("校验器校验：更新团队时描述超长报错，合法描述通过")
    void testValidatorUpdateDescription() {
        TeamCommand command = new TeamCommand();
        command.setId(10L);
        command.setDescription("b".repeat(Team.MAX_DESCRIPTION_LENGTH + 1));

        String error = validator.validateForUpdate(command);
        assertNotNull(error);
        assertTrue(error.contains("团队描述长度不能超过"));

        command.setDescription("更新后的描述");
        String pass = validator.validateForUpdate(command);
        assertNull(pass);
    }

    @Test
    @DisplayName("TeamRequest 转 TeamCommand 时 description 字段正常传递并成功添加")
    void testControllerAddWithDescription() {
        when(agentService.queryIn(anyList())).thenReturn(Result.success(List.of(
                createAgent(1L, "Leader"),
                createAgent(2L, "Worker")
        )));

        TeamRequest request = new TeamRequest();
        request.setName("架构组");
        request.setDescription("负责微服务设计与重构");
        request.setCommanderAgentId(1L);
        request.setAgentIds(List.of(1L, 2L));

        Result<Void> result = controller.add(request);
        assertEquals(1, result.getCode());

        ArgumentCaptor<Team> captor = ArgumentCaptor.forClass(Team.class);
        verify(repository).save(captor.capture());
        Team saved = captor.getValue();
        assertEquals("架构组", saved.getName());
        assertEquals("负责微服务设计与重构", saved.getDescription());
        assertEquals(1L, saved.getCommanderAgentId());
        assertEquals(List.of(1L, 2L), saved.getAgentIds());
    }

    @Test
    @DisplayName("更新团队描述与字段时，正确驱动模型方法更新")
    void testUpdateTeamDescription() {
        Team existing = Team.builder()
                .id(10L)
                .name("旧团队名")
                .description("旧描述")
                .commanderAgentId(1L)
                .agentIds(List.of(1L, 2L))
                .build();
        when(repository.findById(10L)).thenReturn(Optional.of(existing));

        TeamRequest request = new TeamRequest();
        request.setId(10L);
        request.setName("新团队名");
        request.setDescription("新描述内容");

        Result<Void> result = controller.update(request);
        assertEquals(1, result.getCode());

        ArgumentCaptor<Team> captor = ArgumentCaptor.forClass(Team.class);
        verify(repository).updateById(captor.capture());
        Team updated = captor.getValue();
        assertEquals("新团队名", updated.getName());
        assertEquals("新描述内容", updated.getDescription());
    }

    @Test
    @DisplayName("查询团队详情时，TeamVO 正确包含团队描述与管理者名称")
    void testFindByIdWithDescription() {
        Team existing = Team.builder()
                .id(10L)
                .name("前端开发组")
                .description("负责灵犀界面开发")
                .commanderAgentId(1L)
                .agentIds(List.of(1L, 2L))
                .build();
        when(repository.findById(10L)).thenReturn(Optional.of(existing));
        when(agentService.queryIn(anyList())).thenReturn(Result.success(List.of(
                createAgent(1L, "LeaderAgent"),
                createAgent(2L, "WorkerAgent")
        )));

        Result<TeamVO> result = controller.findById(10L);
        assertEquals(1, result.getCode());
        TeamVO vo = result.getData();
        assertNotNull(vo);
        assertEquals("前端开发组", vo.getName());
        assertEquals("负责灵犀界面开发", vo.getDescription());
        assertEquals(1L, vo.getCommanderAgentId());
        assertEquals("LeaderAgent", vo.getCommanderName());
        assertEquals(2, vo.getAgents().size());
    }

    @Test
    @DisplayName("分页查询团队时，TeamVO 正确包含团队描述")
    void testFindPageWithDescription() {
        Team team1 = Team.builder()
                .id(1L)
                .name("算法组")
                .description("负责推荐系统优化")
                .commanderAgentId(10L)
                .agentIds(List.of(10L))
                .build();
        IPage<Team> pageMock = new Page<>(1, 10, 1);
        pageMock.setRecords(List.of(team1));
        when(repository.queryByPage(anyInt(), anyInt())).thenReturn(pageMock);
        when(agentService.queryIn(anyList())).thenReturn(Result.success(List.of(
                createAgent(10L, "AlgoLead")
        )));

        Result<PageResult<TeamVO>> result = controller.listPage(1, 10);
        assertEquals(1, result.getCode());
        PageResult<TeamVO> pageResult = result.getData();
        assertEquals(1, pageResult.getRecords().size());
        TeamVO vo = pageResult.getRecords().iterator().next();
        assertEquals("算法组", vo.getName());
        assertEquals("负责推荐系统优化", vo.getDescription());
        assertEquals("AlgoLead", vo.getCommanderName());
    }

    @Test
    @DisplayName("根据 ID 删除团队时调用仓储删除接口")
    void testDelById() {
        Team team = Team.builder().id(99L).name("测试团队").build();
        when(repository.findById(99L)).thenReturn(Optional.of(team));

        Result<Void> result = controller.delById(99L);
        assertEquals(1, result.getCode());
        verify(repository).delete(team);
    }
}
