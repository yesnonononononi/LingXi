package com.summit.dp.workflow.pending;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.application.chat.ChatCommand;
import com.summit.dp.workflow.application.pending.PendingAttachmentContent;
import com.summit.dp.workflow.application.pending.PendingTaskService;
import com.summit.dp.workflow.application.pending.PendingTaskSnapshot;
import com.summit.dp.workflow.application.pending.PendingTaskUpdate;
import com.summit.dp.workflow.domain.pending.model.PendingAttachment;
import com.summit.dp.workflow.domain.pending.model.PendingTask;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.web.multipart.MultipartFile;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 待发送队列的入队 / 修改 / 门禁契约。
 *
 * <p>这里钉住三件会悄悄坏掉的事：图片入队后**只在磁盘**、快照只给数量不给字节、
 * 修改时的交并**不能**变成「全删重建」（那会把用户保留的图一起删掉）。</p>
 */
class PendingTaskQueueTest {

    private static final long SESSION = 900L;

    private final PendingTaskTestSupport.InMemoryRepository rows = new PendingTaskTestSupport.InMemoryRepository();
    private final PendingTaskTestSupport.InMemoryAttachmentStore files = new PendingTaskTestSupport.InMemoryAttachmentStore();
    private final PendingTaskService service = new PendingTaskService(rows, files);

    private static ChatCommand command(String input, MockMultipartFile... images) {
        List<MultipartFile> attached = new ArrayList<>(List.of(images));
        return new ChatCommand(input, SESSION, 7L, 3L, null, 9L, false, attached, List.of());
    }

    private static MockMultipartFile image(String name, byte[] data) {
        return new MockMultipartFile("image", name, "image/png", data);
    }

    /** 只改内容、不动模型与执行体的编辑提交（与 {@link #command} 的取值保持同一组）。 */
    private static PendingTaskUpdate edit(String input, List<String> keepIds, MultipartFile... images) {
        return new PendingTaskUpdate(input, keepIds, List.of(images), false, 7L, 3L);
    }

    @Test
    void enqueueKeepsImagesOnDiskAndSnapshotOnlyReportsCount() {
        String pendingId = service.enqueue(SESSION, command("这两张图有什么区别",
                image("a.png", new byte[]{1, 2, 3}), image("b.png", new byte[]{4, 5})));

        PendingTaskSnapshot snapshot = service.snapshot(SESSION);
        assertEquals(1, snapshot.entries().size());
        PendingTaskSnapshot.Entry entry = snapshot.entries().getFirst();
        assertEquals(pendingId, entry.id());
        assertEquals(2, entry.attachments().size());
        assertTrue(entry.attachments().stream().allMatch(attachment -> attachment.name().endsWith(".png")));
        assertEquals("PENDING", entry.status());
        assertEquals(2, files.fileCount());
        assertFalse(files.relPaths().iterator().next().contains("base64"));
    }

    @Test
    void updateMergesRetainedAttachmentsAndDeletesOnlyFilteredOnes() {
        service.enqueue(SESSION, command("先这样", image("a.png", new byte[]{1, 2, 3})));
        PendingTask first = rows.findBySession(SESSION).getFirst();
        String keptId = first.getAttachments().getFirst().id();
        String keptPath = first.getAttachments().getFirst().relPath();

        // 保留 a 再补一张新图：结果是「旧的没白传 + 新的进来了」，不是全删重建。
        service.update(SESSION, String.valueOf(first.getId()), edit("两张都看", List.of(keptId),
                image("c.png", new byte[]{9, 9})));
        PendingTask merged = rows.findBySession(SESSION).getFirst();
        assertEquals("两张都看", merged.getInput());
        assertEquals(2, merged.getAttachments().size());
        assertTrue(merged.getAttachments().stream().anyMatch(attachment -> attachment.id().equals(keptId)),
                "被保留的附件必须还在");
        assertTrue(files.relPaths().contains(keptPath), "保留的附件不能落到磁盘上被删掉再重建");
        assertEquals(2, files.fileCount());

        // 只保留后加的那张：被过滤掉的那张文件必须真的从磁盘消失，另一张不受影响。
        String addedId = merged.getAttachments().stream()
                .map(PendingAttachment::id)
                .filter(id -> !id.equals(keptId))
                .findFirst().orElseThrow();
        service.update(SESSION, String.valueOf(first.getId()), edit("只看新的", List.of(addedId)));
        PendingTask trimmed = rows.findBySession(SESSION).getFirst();
        assertEquals(1, trimmed.getAttachments().size());
        assertEquals(addedId, trimmed.getAttachments().getFirst().id());
        assertEquals(1, files.fileCount(), "被过滤掉的那张必须从磁盘删除");
    }

    @Test
    void enqueueRejectedWhileTaskAwaitingConfirm() {
        service.enqueue(SESSION, command("第一条"));
        PendingTask task = rows.findBySession(SESSION).getFirst();
        task.markAwaitingConfirm(Instant.now());

        ClientException rejected = assertThrows(ClientException.class,
                () -> service.enqueue(SESSION, command("第二条")));
        assertTrue(rejected.getMessage().contains("上次未发送"));
    }

    @Test
    void enqueueRejectedWhileTaskPaused() {
        service.enqueue(SESSION, command("第一条"));
        PendingTask task = rows.findBySession(SESSION).getFirst();
        task.fail("模型调用失败", Instant.now());

        ClientException rejected = assertThrows(ClientException.class,
                () -> service.enqueue(SESSION, command("第二条")));
        assertTrue(rejected.getMessage().contains("发送失败"));
    }

    @Test
    void confirmMakesAwaitingTaskDispatchableAgain() {
        service.enqueue(SESSION, command("第一条"));
        PendingTask task = rows.findBySession(SESSION).getFirst();
        task.markAwaitingConfirm(Instant.now());

        service.confirm(SESSION, String.valueOf(task.getId()));

        assertEquals("PENDING", rows.findBySession(SESSION).getFirst().getStatus().name());
        assertTrue(rows.findBySession(SESSION).getFirst().dispatchable());
    }

    @Test
    void updateOverwritesModelAgentAndPlanFlagOnTheSameRow() {
        service.enqueue(SESSION, command("先这样"));

        // 编辑面板总能算出当前界面的选择，所以这三项是整笔覆盖：清成「不指定」也得落库。
        service.update(SESSION, String.valueOf(rows.findBySession(SESSION).getFirst().getId()),
                new PendingTaskUpdate("换了执行体", null, List.of(), true, 11L, null));

        PendingTask updated = rows.findBySession(SESSION).getFirst();
        assertEquals("换了执行体", updated.getInput());
        assertTrue(updated.isRequirePlan(), "计划模式必须跟着这次编辑落库");
        assertEquals(11L, updated.getModelId());
        assertNull(updated.getAgentId(), "清回「不指定」必须真的变成 null，不能被当成「不改」");
    }

    @Test
    void updateRejectsNonPositiveAgentId() {
        service.enqueue(SESSION, command("先这样"));
        String pendingId = String.valueOf(rows.findBySession(SESSION).getFirst().getId());

        ClientException rejected = assertThrows(ClientException.class, () -> service.update(SESSION, pendingId,
                new PendingTaskUpdate("文本", null, List.of(), false, 7L, 0L)));
        assertTrue(rejected.getMessage().contains("执行体标识不合法"));
    }

    @Test
    void updateWithoutKeepIdsLeavesAttachmentsUntouched() {
        service.enqueue(SESSION, command("先这样", image("a.png", new byte[]{1, 2, 3})));
        PendingTask first = rows.findBySession(SESSION).getFirst();
        String keptId = first.getAttachments().getFirst().id();

        // 只改文字时前端不带 keepAttachmentIds：语义是「附件不动」，不是「全丢」。
        service.update(SESSION, String.valueOf(first.getId()), edit("只改文字", null));

        PendingTask updated = rows.findBySession(SESSION).getFirst();
        assertEquals("只改文字", updated.getInput());
        assertEquals(1, updated.getAttachments().size());
        assertEquals(keptId, updated.getAttachments().getFirst().id());
        assertEquals(1, files.fileCount(), "附件不动就不能有文件被删");
    }

    @Test
    void readAttachmentReturnsStoredBytesAndRejectsForeignScope() {
        String pendingId = service.enqueue(SESSION, command("看这张", image("a.png", new byte[]{7, 8, 9})));
        String attachmentId = rows.findBySession(SESSION).getFirst().getAttachments().getFirst().id();

        PendingAttachmentContent content = service.readAttachment(SESSION, pendingId, attachmentId);
        assertEquals("a.png", content.name());
        assertEquals("image/png", content.mime());
        assertArrayEquals(new byte[]{7, 8, 9}, content.data());

        // 换个会话 id 就够不着：附件 id 是可猜的十六位串，不校验等于把别人的图挂到自己的地址上。
        ClientException foreign = assertThrows(ClientException.class,
                () -> service.readAttachment(SESSION + 1, pendingId, attachmentId));
        assertTrue(foreign.getMessage().contains("不属于该会话"));

        ClientException unknown = assertThrows(ClientException.class,
                () -> service.readAttachment(SESSION, pendingId, "ffffffffffffffff"));
        assertTrue(unknown.getMessage().contains("不存在"));
    }

    @Test
    void attachmentPathCannotEscapeSessionDirectory() {
        ClientException rejected = assertThrows(ClientException.class,
                () -> new PendingAttachment("a1b2c3d4e5f60718", "x.png", "image/png", 3,
                        "../../etc/passwd"));
        assertTrue(rejected.getMessage().contains("路径不合法"));
    }

    @Test
    void cancelRemovesRowAndFiles() {
        String pendingId = service.enqueue(SESSION, command("不要了", image("a.png", new byte[]{1})));
        assertEquals(1, files.fileCount());

        service.cancel(SESSION, pendingId);

        assertFalse(service.hasPending(SESSION));
        assertEquals(0, files.fileCount());
    }
}
