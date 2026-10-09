package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Image;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.session.application.convert.SessionMessageViewAssembler;
import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.shared.config.JsonConfig;
import com.summit.dp.shared.vo.SessionMessageVO;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class UserImageViewTest {
    private final ObjectMapper json = new JsonConfig().objectMapper();
    private final List<String> expected = List.of("data:image/png;base64,cG5n", "https://example.com/second.jpg", "data:image/jpeg;base64,anBlZw==");

    @Test
    void persistedImagesSurviveMessageAndTurnHistoryInTheirOriginalOrder() throws Exception {
        UserMessageEntity user = UserMessageEntity.from("比较图片", List.of(Image.from("cG5n", "image/png"),
                Image.from(URI.create("https://example.com/second.jpg")), Image.from("anBlZw==", "image/jpeg")));
        SessionMessage stored = SessionMessage.builder().id(10L).sessionId(42L).turnId(43L)
                .type(SessionMessageType.USER).text(json.writeValueAsString(user)).createTime(Instant.EPOCH).build();
        SessionMessage otherTurn = SessionMessage.builder().id(9L).sessionId(42L).turnId(44L)
                .type(SessionMessageType.USER).text(json.writeValueAsString(UserMessageEntity.from("其他轮次", Image.from("eA==")))).build();
        SessionMessageVO message = new SessionMessageViewAssembler(json, new ToolCallConverter(json)).toVO(stored);
        assertEquals("比较图片", message.getText());
        assertEquals(expected, message.getImageUrls());
        TurnViewAssembler turns = new TurnViewAssembler(json, null);
        assertEquals(expected, turns.resolveUserImageUrls(43L, List.of(otherTurn, stored)));
        assertEquals(List.of(), turns.resolveUserImageUrls(45L, List.of(otherTurn, stored)));
        TurnViewVO view = new TurnViewVO(42L, 43L, "COMPLETED", 1L, "比较图片", expected, List.of(), null);
        assertEquals(expected, json.readValue(json.writeValueAsString(view), TurnViewVO.class).userImageUrls());
    }

    @Test
    void imageListsCannotBeChangedThroughTheCallerAfterViewCreation() {
        List<String> source = new ArrayList<>(expected);
        TurnViewVO view = new TurnViewVO(42L, 43L, "COMPLETED", 1L, "比较图片", source, List.of(), null);
        source.clear();
        assertEquals(expected, view.userImageUrls());
    }
}
