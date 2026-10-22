package com.summit.dp.provider;

import com.summit.dp.provider.application.command.ProviderConfigCommand;
import com.summit.dp.provider.application.service.impl.ProviderConfigServiceImpl;
import com.summit.dp.provider.domain.model.ProviderConfig;
import com.summit.dp.provider.domain.repo.ProviderConfigRepository;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 提供商预设的输入护栏：名称唯一、密钥掩码回传不落库、删除不写回其它记录。 */
class ProviderConfigServiceTest {

    private final ProviderConfigRepository repository = mock(ProviderConfigRepository.class);
    private final ProviderConfigServiceImpl service = new ProviderConfigServiceImpl(repository);

    @Test
    void creationReturnsTheRepositoryIdForFollowingBatchRequests() {
        when(repository.saveAndReturnId(any())).thenReturn(9007199254740993L);
        assertEquals(9007199254740993L, service.add(new ProviderConfigCommand(null, "自定义", null,
                "https://example.invalid/v1", "key", 0)).getData());
    }

    @Test
    void rejectsDuplicateNameIgnoringCaseAndRequiresName() {
        when(repository.existsByName("DeepSeek", null)).thenReturn(true);
        assertThrows(ClientException.class,
                () -> service.add(new ProviderConfigCommand(null, "DeepSeek", null, null, "key", 0)));
        assertThrows(ClientException.class,
                () -> service.add(new ProviderConfigCommand(null, "  ", null, null, "key", 0)));
        verify(repository, never()).saveAndReturnId(any());
    }

    @Test
    void echoedMaskedKeyKeepsTheStoredSecret() {
        ProviderConfig existing = new ProviderConfig(7L, "DeepSeek", "deepseek",
                "https://api.deepseek.com/v1", "sk-0123456789", 0);
        when(repository.findById(7L)).thenReturn(Optional.of(existing));
        when(repository.existsByName("DeepSeek", 7L)).thenReturn(false);

        // 前端把展示值原样回传：不能把掩码写成真实密钥。
        service.update(new ProviderConfigCommand(7L, "DeepSeek", "deepseek",
                null, existing.getMaskedApiKey(), 1));

        ArgumentCaptor<ProviderConfig> updated = ArgumentCaptor.forClass(ProviderConfig.class);
        verify(repository).updateById(updated.capture());
        assertEquals("sk-0123456789", updated.getValue().getApiKey());
        assertEquals(1, updated.getValue().getSortOrder());
    }

    @Test
    void deleteRemovesOnlyThePreset() {
        ProviderConfig existing = new ProviderConfig(7L, "DeepSeek", null, null, "sk-0123456789", 0);
        when(repository.findById(7L)).thenReturn(Optional.of(existing));

        service.del(7L);

        verify(repository).delete(existing);
        // 不级联：不写回任何记录，模型侧保留悬空 provider_config_id，聚合时归入「未分组」。
        verify(repository, never()).updateById(any());
    }

    @Test
    void deleteRejectsUnknownProvider() {
        when(repository.findById(99L)).thenReturn(Optional.empty());
        assertThrows(ClientException.class, () -> service.del(99L));
        verify(repository, never()).delete(any());
    }

    @Test
    void blankIconAndBaseUrlBecomeNullSoAggregationHasNoEmptyStrings() {
        service.add(new ProviderConfigCommand(null, "自定义", "  ", "", "", 0));
        ArgumentCaptor<ProviderConfig> saved = ArgumentCaptor.forClass(ProviderConfig.class);
        verify(repository).saveAndReturnId(saved.capture());
        assertEquals(null, saved.getValue().getIcon());
        assertEquals(null, saved.getValue().getBaseUrl());
        assertEquals("", saved.getValue().getApiKey());
        assertTrue(saved.getValue().getSortOrder() == 0);
        verify(repository, never()).existsByName(eq("别的名字"), any());
    }
}
