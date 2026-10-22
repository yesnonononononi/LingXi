package com.summit.dp.model;

import com.summit.dp.model.application.command.ModelConfigCommand;
import com.summit.dp.model.application.service.ModelServiceImpl;
import com.summit.dp.model.application.vo.ProviderModelGroupVO;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import com.summit.dp.provider.application.service.ProviderConfigService;
import com.summit.dp.provider.application.vo.ProviderConfigVO;
import com.summit.dp.shared.exception.ClientException;
import com.summit.harness.springbootautoconfigure.properties.agent.AgentChatProperties;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 聚合查询守卫：同名模型靠 provider_config 分组，悬空引用必须落到「未分组」而不是消失。
 */
class ProviderModelCatalogTest {

    private final ModelConfigRepository repository = mock(ModelConfigRepository.class);
    private final ProviderConfigService providerService = mock(ProviderConfigService.class);
    private final ModelServiceImpl service = new ModelServiceImpl(repository, providerService, new AgentChatProperties());

    @Test
    void groupsModelsByProviderAndKeepsDanglingReferencesUngrouped() {
        when(providerService.findAllViews()).thenReturn(List.of(
                ProviderConfigVO.builder().id(10L).name("DeepSeek").icon("deepseek").build(),
                ProviderConfigVO.builder().id(20L).name("中转站").build()));
        when(repository.findAll()).thenReturn(List.of(
                model(1L, "claude-opus-4-7", 10L),
                model(2L, "deepseek-v4-flash-free", 10L),
                model(3L, "claude-opus-4-7", 20L),
                model(4L, "legacy-model", 999L),
                model(5L, "no-provider", null)));

        List<ProviderModelGroupVO> groups = service.catalog().getData();

        assertEquals(3, groups.size(), "两个提供商 + 末尾未分组");
        assertEquals("DeepSeek", groups.get(0).getProviderName());
        assertEquals(2, groups.get(0).getModelCount());
        // 组内按模型名排序：deepseek-v4-flash-free 在 claude-opus-4-7 之后
        assertEquals("claude-opus-4-7", groups.get(0).getModels().get(0).getModelName());
        assertEquals("DeepSeek", groups.get(0).getModels().get(0).getProviderName());
        assertEquals("deepseek", groups.get(0).getModels().get(0).getProviderIcon());
        assertEquals(20L, groups.get(1).getProviderConfigId());
        assertNull(groups.get(2).getProviderConfigId(), "未分组没有 providerConfigId");
        assertEquals(2, groups.get(2).getModelCount(), "悬空引用与无归属都必须留在未分组");
    }

    @Test
    void addRejectsUnknownProviderAndZeroDetachesExistingModel() {
        when(providerService.findAllViews()).thenReturn(List.of(
                ProviderConfigVO.builder().id(10L).name("DeepSeek").build()));

        assertThrows(ClientException.class,
                () -> service.add(new ModelConfigCommand(null, "m", "https://example.invalid", "k", true, 404L)));

        service.add(new ModelConfigCommand(null, "m", "https://example.invalid", "k", true, 10L));
        ArgumentCaptor<ModelConfig> saved = ArgumentCaptor.forClass(ModelConfig.class);
        verify(repository).save(saved.capture());
        assertEquals(10L, saved.getValue().getProviderConfigId());

        ModelConfig existing = model(1L, "m", 10L);
        when(repository.findById(1L)).thenReturn(Optional.of(existing));
        service.update(new ModelConfigCommand(1L, null, null, null, null, 0L));
        assertNull(existing.getProviderConfigId(), "0 = 显式解除归属");
        assertNotNull(existing.getModelName(), "未传的字段保持原值");
    }

    @Test
    void copiesProviderKeyIntoTheModelWhenOptedIn() {
        when(providerService.findAllViews()).thenReturn(List.of(
                ProviderConfigVO.builder().id(10L).name("DeepSeek").build()));
        when(providerService.findApiKey(10L)).thenReturn(Optional.of("sk-provider-secret"));

        // 勾选复用：即使 apiKey 留空也必须把提供方密钥复制进来。
        service.add(new ModelConfigCommand(null, "m", "https://example.invalid", null, true, 10L, true));

        ArgumentCaptor<ModelConfig> saved = ArgumentCaptor.forClass(ModelConfig.class);
        verify(repository).save(saved.capture());
        assertEquals("sk-provider-secret", saved.getValue().getApiKey(), "密钥在落库时复制，运行期不再回落");
        assertEquals(10L, saved.getValue().getProviderConfigId());
    }

    @Test
    void rejectingProviderKeyReuseWhenProviderHasNoSecret() {
        when(providerService.findAllViews()).thenReturn(List.of(
                ProviderConfigVO.builder().id(10L).name("DeepSeek").build()));
        when(providerService.findApiKey(10L)).thenReturn(Optional.empty());

        assertThrows(ClientException.class,
                () -> service.add(new ModelConfigCommand(null, "m", "https://example.invalid", null, true, 10L, true)));
        verify(repository, never()).save(any());
    }

    @Test
    void updateReusesProviderKeyOnlyWhenExplicitlyAsked() {
        when(providerService.findAllViews()).thenReturn(List.of(
                ProviderConfigVO.builder().id(10L).name("DeepSeek").build()));
        when(providerService.findApiKey(10L)).thenReturn(Optional.of("sk-provider-secret"));
        ModelConfig existing = model(1L, "m", 10L);
        existing.changeApiKey("sk-old");
        when(repository.findById(1L)).thenReturn(Optional.of(existing));

        // 未勾选且不传 apiKey = 保留原密钥，绝不能顺带查提供商密钥。
        service.update(new ModelConfigCommand(1L, null, null, null, null, 10L, null));
        assertEquals("sk-old", existing.getApiKey());
        verify(providerService, never()).findApiKey(10L);

        service.update(new ModelConfigCommand(1L, null, null, null, null, 10L, true));
        assertEquals("sk-provider-secret", existing.getApiKey());
    }

    private static ModelConfig model(Long id, String modelName, Long providerConfigId) {
        return new ModelConfig(id, "https://example.invalid", "key", modelName, null, providerConfigId, false);
    }
}
