package com.summit.dp.agent.application.service.impl;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.AgentCommand;
import com.summit.dp.agent.domain.model.Agent;
import com.summit.dp.agent.domain.repository.AgentRepository;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.vo.ModelConfigVO;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * {@code AgentServiceImpl} 的入口校验与字段应用：校验不过一律回业务错误且不得落库，
 * 通过后只应用本次传入（非 null）的字段。
 */
class AgentServiceTest {

    private final AgentRepository repository = mock(AgentRepository.class);
    private final ModelService modelService = mock(ModelService.class);
    private final ToolCatalog toolCatalog = mock(ToolCatalog.class);
    private final AgentServiceImpl service =
            new AgentServiceImpl(repository, new AgentValidator(modelService, toolCatalog));

    private AgentCommand validCreate() {
        AgentCommand command = new AgentCommand();
        command.setName("客服助手");
        command.setModelId(9L);
        command.setPrompt("你是助手");
        return command;
    }

    private void stubValidDependencies() {
        when(modelService.findById(any())).thenReturn(Result.success(mock(ModelConfigVO.class)));
        when(toolCatalog.names()).thenReturn(Set.of("read_file"));
    }

    @Test
    @DisplayName("按 id 查询：id 为空拒成业务错误")
    void findByIdRejectsNull() {
        assertThrows(ClientException.class, () -> service.findById(null));
    }

    @Test
    @DisplayName("按 id 查询：不存在拒成业务错误，不得漏成 500")
    void findByIdRejectsMissing() {
        when(repository.findById(7L)).thenReturn(Optional.empty());
        assertThrows(ClientException.class, () -> service.findById(7L));
    }

    @Test
    @DisplayName("新增：校验不过不落库")
    void addRejectsInvalidWithoutSaving() {
        AgentCommand command = validCreate();
        command.setName("   ");
        assertThrows(ClientException.class, () -> service.add(command));
        verify(repository, never()).save(any());
    }

    @Test
    @DisplayName("新增：校验通过则以「启用」态落库")
    void addPersistsEnabledAgent() {
        stubValidDependencies();
        service.add(validCreate());

        ArgumentCaptor<Agent> saved = ArgumentCaptor.forClass(Agent.class);
        verify(repository).save(saved.capture());
        assertEquals("客服助手", saved.getValue().getName());
        assertEquals(Agent.STATUS_ENABLED, saved.getValue().getStatus());
    }

    @Test
    @DisplayName("更新：校验不过不落库")
    void updateRejectsInvalidWithoutSaving() {
        AgentCommand command = new AgentCommand();
        command.setId(1L);
        command.setPrompt("   ");
        assertThrows(ClientException.class, () -> service.update(command));
        verify(repository, never()).updateById(any());
    }

    @Test
    @DisplayName("更新：只改本次传入字段，未传入字段保持原值")
    void updateAppliesOnlyProvidedFields() {
        stubValidDependencies();
        Agent existing = Agent.builder().id(1L).name("旧名").modelId(9L).prompt("旧词").build();
        when(repository.findById(1L)).thenReturn(Optional.of(existing));

        AgentCommand command = new AgentCommand();
        command.setId(1L);
        command.setName("新名");

        service.update(command);

        ArgumentCaptor<Agent> updated = ArgumentCaptor.forClass(Agent.class);
        verify(repository).updateById(updated.capture());
        assertEquals("新名", updated.getValue().getName());
        assertEquals("旧词", updated.getValue().getPrompt(), "未传入的字段不能被清掉");
    }

    @Test
    @DisplayName("删除：id 为空拒成业务错误")
    void delByIdRejectsNull() {
        assertThrows(ClientException.class, () -> service.delById(null));
    }

    @Test
    @DisplayName("分页：非法页码/页大小一律收敛为 1")
    void findPageClampsPaging() {
        IPage<Agent> page = mock(IPage.class);
        when(page.getRecords()).thenReturn(List.of());
        when(repository.queryByPage(anyInt(), anyInt())).thenReturn(page);

        service.findPage(0, 0);

        verify(repository).queryByPage(1, 1);
    }
}
