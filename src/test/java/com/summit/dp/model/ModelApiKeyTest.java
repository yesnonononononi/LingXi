package com.summit.dp.model;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.model.application.command.ModelConfigCommand;
import com.summit.dp.model.application.service.ModelServiceImpl;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.provider.application.service.ProviderConfigService;
import com.summit.harness.springbootautoconfigure.properties.agent.AgentChatProperties;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ModelApiKeyTest {
    private final ModelConfigRepository repository = mock(ModelConfigRepository.class);
    private final ModelServiceImpl service = new ModelServiceImpl(repository, mock(ProviderConfigService.class),
            new AgentChatProperties());

    @Test void runtimeSelectionKeepsTheConnectionAndVisionInOneSnapshot() {
        ModelConfig existing = model("key");
        existing.changeVision(true);
        when(repository.findById(1L)).thenReturn(Optional.of(existing));
        RuntimeModel snapshot = service.resolveRuntimeConfig(1L, null);
        verify(repository).findById(1L);
        existing.changeVision(false);
        existing.changeModelName("gpt-4o");
        assertTrue(snapshot.vision());
        assertEquals("test", snapshot.config().getModelName());
        assertFalse(service.resolveRuntimeConfig(1L, null).vision());
    }

    @Test void visionIsExplicitOnAddAndCanBeDisabledOnEdit() {
        assertThrows(ClientException.class, () -> service.add(new ModelConfigCommand(null, "custom-model", "https://example.invalid", "key", null)));
        service.add(new ModelConfigCommand(null, "custom-model", "https://example.invalid", "key", true));
        ArgumentCaptor<ModelConfig> saved = ArgumentCaptor.forClass(ModelConfig.class);
        verify(repository).save(saved.capture());
        assertTrue(saved.getValue().isVision());

        ModelConfig existing = new ModelConfig(1L, "https://example.invalid", "key", "custom-model", null, true);
        when(repository.findById(1L)).thenReturn(Optional.of(existing));
        assertTrue(service.findById(1L).getData().isVision());
        service.update(new ModelConfigCommand(1L, null, null, null, false));
        assertFalse(existing.isVision());
        assertEquals("custom-model", existing.getModelName());
        assertEquals("key", existing.getApiKey());
        assertFalse(service.findById(1L).getData().isVision());
    }

    @Test void masksTwentyPercentAtEachEndAndHandlesShortValues() {
        assertEquals("01***89", model("0123456789").getMaskedApiKey());
        assertEquals("0***6", model("0123456").getMaskedApiKey());
        assertEquals("***", model("abc").getMaskedApiKey());
        assertEquals("", model("").getMaskedApiKey());
        assertNull(model(null).getMaskedApiKey());
        assertEquals("😀***😄", model("😀😁😂😃😄").getMaskedApiKey());
    }

    @Test void addPersistsOriginalValue() {
        service.add(new ModelConfigCommand(null, "test", "https://example.invalid", "0123456789", false));
        ArgumentCaptor<ModelConfig> saved = ArgumentCaptor.forClass(ModelConfig.class);
        verify(repository).save(saved.capture());
        assertEquals("0123456789", saved.getValue().getApiKey());
    }

    @Test void editPreservesOmittedOrMaskedValuesAndReplacesNewValues() {
        ModelConfig model = model("0123456789");
        when(repository.findById(1L)).thenReturn(Optional.of(model));
        service.update(new ModelConfigCommand(1L, "test", "https://example.invalid", null, false));
        assertEquals("0123456789", model.getApiKey());
        service.update(new ModelConfigCommand(1L, "test", "https://example.invalid", "01***89", false));
        assertEquals("0123456789", model.getApiKey());
        service.update(new ModelConfigCommand(1L, "test", "https://example.invalid", "new-key", false));
        assertEquals("new-key", model.getApiKey());
    }

    @Test void clearWritesAnEmptyDatabaseValueAndReturnsUnconfiguredStatus() {
        ModelConfig model = model("0123456789");
        when(repository.findById(1L)).thenReturn(Optional.of(model));
        service.clearCredential(1L);
        verify(repository).updateById(model);
        assertEquals("", model.getApiKey());
        assertFalse(service.findById(1L).getData().isCredentialConfigured());
    }

    @Test void detailAndListNeverReturnTheFullKey() throws Exception {
        ModelConfig model = model("0123456789");
        when(repository.findById(1L)).thenReturn(Optional.of(model));
        Page<ModelConfig> page = new Page<>(1, 10, 1);
        page.setRecords(List.of(model));
        when(repository.page(1, 10)).thenReturn(page);
        ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();
        String detail = mapper.writeValueAsString(service.findById(1L));
        String list = mapper.writeValueAsString(service.list(1, 10));
        assertTrue(detail.contains("01***89"));
        assertTrue(list.contains("01***89"));
        assertFalse(detail.contains("0123456789"));
        assertFalse(list.contains("0123456789"));
    }

    @Test void runtimeConfigUsesOriginalDatabaseKey() {
        when(repository.findById(1L)).thenReturn(Optional.of(model("0123456789")));
        assertEquals("0123456789", service.runtimeConfig(1L, null).getApiKey());
    }

    @Test void runtimeConfigRejectsMissingAndIncompleteModels() {
        assertThrows(ClientException.class,
                () -> service.runtimeConfig(null, null));
        when(repository.findById(99L)).thenReturn(Optional.empty());
        assertThrows(ClientException.class,
                () -> service.runtimeConfig(99L, null));
        when(repository.findById(1L)).thenReturn(Optional.of(model("")));
        assertThrows(ClientException.class,
                () -> service.runtimeConfig(1L, null));
    }

    private ModelConfig model(String key) {
        return new ModelConfig(1L, "https://example.invalid", key, "test", null, false);
    }
}
