package com.summit.dp.model;

import com.summit.dp.model.api.controller.ModelController;
import com.summit.dp.model.application.command.ModelConfigCommand;
import com.summit.dp.model.application.service.ModelServiceImpl;
import com.summit.dp.model.application.vo.ModelConfigVO;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import com.summit.dp.provider.application.service.ProviderConfigService;
import com.summit.dp.provider.application.vo.ProviderConfigVO;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.harness.springbootautoconfigure.properties.agent.AgentChatProperties;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ModelProviderCredentialTest {
    private final ModelConfigRepository repository = mock(ModelConfigRepository.class);
    private final ProviderConfigService providers = mock(ProviderConfigService.class);
    private final ModelServiceImpl service = new ModelServiceImpl(repository, providers, new AgentChatProperties());

    @Test
    void defaultCreationReferencesProviderWithoutCopyingEitherSubmittedOrProviderKey() {
        when(providers.findAllViews()).thenReturn(List.of(provider()));
        when(providers.findApiKey(10L)).thenReturn(Optional.of("provider-secret"));
        service.add(new ModelConfigCommand(null, "model", "https://example.invalid", "ignored-secret", false, 10L));
        ArgumentCaptor<ModelConfig> saved = ArgumentCaptor.forClass(ModelConfig.class);
        verify(repository).save(saved.capture());
        assertTrue(saved.getValue().isUseProvider());
        assertEquals(10L, saved.getValue().getProviderConfigId());
        assertEquals("", saved.getValue().getApiKey());
    }

    @Test
    void runtimeReadsCurrentKeyFromTheSelectedProviderAndNeverFallsBackToModelKey() {
        ModelConfig model = model(true);
        when(repository.findById(1L)).thenReturn(Optional.of(model));
        when(providers.findApiKey(10L)).thenReturn(Optional.of("first-key"), Optional.of("rotated-key"), Optional.empty());
        assertEquals("first-key", service.runtimeConfig(1L, null).getApiKey());
        assertEquals("rotated-key", service.runtimeConfig(1L, null).getApiKey());
        ClientException missing = assertThrows(ClientException.class, () -> service.runtimeConfig(1L, null));
        assertTrue(missing.getMessage().contains("API Key"));
        when(providers.findApiKey(10L)).thenReturn(Optional.of("  "));
        assertThrows(ClientException.class, () -> service.runtimeConfig(1L, null));
        model.changeProviderConfigId(null);
        assertThrows(ClientException.class, () -> service.runtimeConfig(1L, null));
    }

    @Test
    void disabledSourceUsesOnlyTheModelsOwnKey() {
        when(repository.findById(1L)).thenReturn(Optional.of(model(false)));
        assertEquals("model-key", service.runtimeConfig(1L, null).getApiKey());
        verify(providers, never()).findApiKey(any());
    }

    @Test
    void editingPreservesSourceThenCanSwitchProviderAndReturnToAnIndependentKey() {
        ModelConfig model = model(true);
        when(repository.findById(1L)).thenReturn(Optional.of(model));
        when(providers.findAllViews()).thenReturn(List.of(provider(), ProviderConfigVO.builder().id(20L).build()));
        when(providers.findApiKey(10L)).thenReturn(Optional.of("first-key"));
        when(providers.findApiKey(20L)).thenReturn(Optional.of("second-key"));
        service.update(new ModelConfigCommand(1L, null, null, null, false));
        assertTrue(model.isUseProvider());
        assertEquals("", model.getApiKey());
        service.update(new ModelConfigCommand(1L, null, null, "ignored", null, 20L, true));
        assertEquals("second-key", service.runtimeConfig(1L, null).getApiKey());
        assertEquals("", model.getApiKey());
        service.update(new ModelConfigCommand(1L, null, null, "own-key", null, null, false));
        assertFalse(model.isUseProvider());
        assertEquals("own-key", service.runtimeConfig(1L, null).getApiKey());
    }

    @Test
    void providerErrorsPreventWritesAndCredentialClearDisablesInheritance() {
        when(providers.findAllViews()).thenReturn(List.of(provider()));
        assertThrows(ClientException.class, () -> service.add(new ModelConfigCommand(null, "model", "https://example.invalid", "own-key", false, null, true)));
        assertThrows(ClientException.class, () -> service.add(new ModelConfigCommand(null, "model", "https://example.invalid", "own-key", false, 10L, true)));
        verify(repository, never()).save(any());
        ModelConfig model = model(true);
        when(repository.findById(1L)).thenReturn(Optional.of(model));
        assertThrows(ClientException.class, () -> service.update(new ModelConfigCommand(1L, "changed", null, null, null, null, true)));
        verify(repository, never()).updateById(any());
        assertEquals("model", model.getModelName());
        service.clearCredential(1L);
        assertFalse(model.isUseProvider());
        assertEquals("", model.getApiKey());
    }

    @Test
    void providerStatusAndMaskedKeyReflectTheSelectedSourceEvenWhenTheReferenceIsDangling() {
        ModelConfig model = model(true);
        when(repository.findById(1L)).thenReturn(Optional.of(model));
        when(providers.findAllViews()).thenReturn(List.of(provider()));
        ModelConfigVO view = service.findById(1L).getData();
        assertTrue(view.isUseProvider());
        assertTrue(view.isCredentialConfigured());
        assertEquals("pr***ey", view.getApiKey());
        when(providers.findAllViews()).thenReturn(List.of());
        view = service.findById(1L).getData();
        assertEquals(10L, view.getProviderConfigId());
        assertFalse(view.isCredentialConfigured());
        assertNull(view.getApiKey());
    }

    @Test
    void compactModelUsesProviderKeyAndRejectsAMissingProviderCredential() {
        ModelConfig chat = model(false);
        ModelConfig compact = new ModelConfig(2L, "https://compact.invalid", "stale-copy", "compact", null, 20L, false, true);
        when(repository.findById(1L)).thenReturn(Optional.of(chat));
        when(repository.findById(2L)).thenReturn(Optional.of(compact));
        when(providers.findApiKey(20L)).thenReturn(Optional.of("compact-provider-key"));
        SettingsView settings = new SettingsView(null, null, null, null, 1L, null, null, null, null, null, 2L);
        assertEquals("compact-provider-key", service.runtimeConfig(1L, settings).getCompactModel().apiKey());
        when(providers.findApiKey(20L)).thenReturn(Optional.empty());
        assertThrows(ClientException.class, () -> service.runtimeConfig(1L, settings));
    }

    @Test
    void endpointAcceptsAndReturnsUseProviderAndCanExplicitlyDisableIt() throws Exception {
        when(providers.findAllViews()).thenReturn(List.of(provider()));
        when(providers.findApiKey(10L)).thenReturn(Optional.of("provider-secret"));
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ModelController(service)).build();
        mvc.perform(post("/model/add").contentType(MediaType.APPLICATION_JSON).content("""
                {"modelName":"model","baseUrl":"https://example.invalid","vision":false,"providerConfigId":10,"useProvider":true}
                """)).andExpect(status().isOk());
        ArgumentCaptor<ModelConfig> saved = ArgumentCaptor.forClass(ModelConfig.class);
        verify(repository).save(saved.capture());
        assertTrue(saved.getValue().isUseProvider());
        assertEquals("", saved.getValue().getApiKey());
        when(repository.findById(1L)).thenReturn(Optional.of(model(true)));
        mvc.perform(get("/model/find/1")).andExpect(jsonPath("$.data.useProvider").value(true));
        mvc.perform(post("/model/update").contentType(MediaType.APPLICATION_JSON)
                .content("{\"id\":1,\"useProvider\":false,\"apiKey\":\"own-key\"}")).andExpect(status().isOk());
        mvc.perform(get("/model/find/1")).andExpect(jsonPath("$.data.useProvider").value(false));
        assertEquals("own-key", service.runtimeConfig(1L, null).getApiKey());
    }

    private ModelConfig model(boolean useProvider) {
        return new ModelConfig(1L, "https://example.invalid", "model-key", "model", null, 10L, false, useProvider);
    }

    private ProviderConfigVO provider() {
        return ProviderConfigVO.builder().id(10L).name("提供方").apiKey("pr***ey").credentialConfigured(true).build();
    }
}
