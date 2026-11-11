package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.session.application.convert.ToolBlockStatusResolver;
import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.shared.vo.block.TurnFileChangeVO;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.application.port.TurnFileChangeQuery;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.TurnModelSnapshot;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 「本轮改动」清单必须随轮次视图同帧下发，且**只在终态轮次**装配。
 *
 * <p>这条契约的由来：清单曾由前端卡片挂载后单独请求汇总，于是会话加载后卡片迟到、
 * 列表高度二次增长，视图被强行顶走一段。数据随视图下发就没有这一次突变。</p>
 *
 * <p>「只在终态」同样是契约：进行中的轮次每块收尾都会装配一次视图，若在那里查文件改动，
 * 整份文件的重放就进了热路径，而前端在轮次收尾前根本不展示清单。</p>
 */
class TurnViewFileChangesTest {

    private static final long SESSION_ID = 9200L;
    private static final long TURN_ID = 9800L;

    private final ObjectMapper json = new ObjectMapper();
    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final ChatTurnRepository chatTurnRepository = mock(ChatTurnRepository.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final TurnFileChangeQuery fileChanges = mock(TurnFileChangeQuery.class);
    private final TurnViewService service = new TurnViewService(
            messageRepository,
            chatTurnRepository,
            toolCallRepository,
            new TurnViewAssembler(json, new ToolBlockStatusResolver(new ToolCallConverter(json))),
            fileChanges);

    @Test
    void terminalTurnCarriesFileChangesInTheSameView() {
        stubMessages();
        List<TurnFileChangeVO> summary = List.of(
                new TurnFileChangeVO("D:/repo/a.txt", 3, 1, 2, false, "100", "7", true));
        when(fileChanges.summarize(TURN_ID)).thenReturn(summary);

        TurnViewVO view = service.assembleTurnView(null, completedTurn(), 1L).orElseThrow();

        assertEquals(summary, view.fileChanges(), "清单必须与终态视图同帧到达");
    }

    @Test
    void runningTurnNeverQueriesFileChanges() {
        stubMessages();

        TurnViewVO view = service.assembleTurnView(null, runningTurn(), 1L).orElseThrow();

        assertTrue(view.fileChanges().isEmpty(), "未收尾的轮次没有清单可展示");
        verify(fileChanges, never()).summarize(anyLong());
    }

    private void stubMessages() {
        SessionMessage ai = SessionMessage.builder()
                .id(10L).sessionId(SESSION_ID).turnId(TURN_ID)
                .responseId("10")
                .type(SessionMessageType.AI).text("{\"type\":\"AI\",\"thinking\":\"想一下\",\"text\":\"正文\"}")
                .build();
        when(messageRepository.findByTurnIds(anyLong(), anyCollection())).thenReturn(List.of(ai));
        when(toolCallRepository.listByIds(anyCollection())).thenReturn(List.of());
    }

    private ChatTurn runningTurn() {
        ChatTurn turn = ChatTurn.accept(TURN_ID, SESSION_ID, null,
                TurnModelSnapshot.of("deepseek-chat", "deepseek", null));
        turn.markRunning(Instant.now());
        return turn;
    }

    private ChatTurn completedTurn() {
        ChatTurn turn = runningTurn();
        turn.markCompleted(null, null, null, Instant.now());
        return turn;
    }
}
