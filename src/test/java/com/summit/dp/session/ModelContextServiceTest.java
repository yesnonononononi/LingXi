package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.*;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.SessionContext;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.summit.dp.shared.config.JsonConfig;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ModelContextServiceTest {
    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    private final SessionContextRepository repository = mock(SessionContextRepository.class);
    private final ModelContextService service = new ModelContextService(mapper, repository);

    @Test
    void storesPlainMessageArrayAndRestoresConcreteMutableMessages() throws Exception {
        when(repository.findById(201L)).thenReturn(Optional.empty());
        service.replace(201L, List.of(SystemMessageEntity.builder().text("system").build(),
                UserMessageEntity.from("hello"), AiMessageEntity.builder().text("answer").build(),
                ToolMessageEntity.builder().id("call").text("result").build()));
        ArgumentCaptor<SessionContext> saved = ArgumentCaptor.forClass(SessionContext.class);
        verify(repository).save(saved.capture());
        assertTrue(mapper.readTree(saved.getValue().getContent()).isArray());
        assertTrue(mapper.readTree(saved.getValue().getContent()).get(1).path("content").isArray());
        when(repository.findById(201L)).thenReturn(Optional.of(saved.getValue()));
        List<Message> restored = service.find(201L).orElseThrow();
        assertInstanceOf(SystemMessageEntity.class, restored.get(0));
        assertInstanceOf(UserMessageEntity.class, restored.get(1));
        assertInstanceOf(AiMessageEntity.class, restored.get(2));
        assertInstanceOf(ToolMessageEntity.class, restored.get(3));
        assertEquals("hello", restored.get(1).text());
        assertDoesNotThrow(() -> restored.add(UserMessageEntity.from("next")));
    }

    @Test
    void replacesExistingContextAndHandlesEmptyHistory() {
        SessionContext existing = SessionContext.create(201L);
        existing.changeContent("[]");
        when(repository.findById(201L)).thenReturn(Optional.of(existing));
        service.replace(201L, List.of());
        verify(repository).updateById(existing);
        assertEquals(2L, existing.getVersion());
        assertTrue(service.find(201L).orElseThrow().isEmpty());
    }

    @Test
    void absentContextStaysAbsentAndLegacyEncodingIsRejected() {
        when(repository.findById(201L)).thenReturn(Optional.empty());
        assertTrue(service.find(201L).isEmpty());
        SessionContext old = SessionContext.create(201L);
        old.changeContent("[{\"type\":\"USER\",\"content\":\"{\\\"type\\\":\\\"USER\\\",\\\"content\\\":[]}\"}]");
        when(repository.findById(201L)).thenReturn(Optional.of(old));
        assertThrows(IllegalStateException.class, () -> service.find(201L));
    }
}
