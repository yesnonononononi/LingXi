package com.summit.dp.workflow.application.pending;

import cn.hutool.core.util.IdUtil;
import com.summit.dp.session.application.port.PendingInputProbe;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.application.chat.ChatCommand;
import com.summit.dp.workflow.domain.pending.model.PendingAttachment;
import com.summit.dp.workflow.domain.pending.model.PendingTask;
import com.summit.dp.workflow.domain.pending.model.PendingTaskStatus;
import com.summit.dp.workflow.domain.pending.repo.PendingTaskRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * 待发送队列的唯一入口：入队、修改、取消、继续、快照。
 *
 * <p><b>DB 是唯一权威</b>：进程内只留两类运行时标记 —— 正在派发的任务 id（快照里的「发送中」）
 * 与「本轮结束后让位自动续跑」的执行序号。它们崩溃即丢正是对的：崩溃后本来就不自动续跑。</p>
 *
 * <p>本类所有方法都自己加锁：调用方另有会话级 {@code control:} 锁，但那是跨模块的编排锁，
 * 不该替队列保证自己的内部一致性。</p>
 */
@Component
@RequiredArgsConstructor
public class PendingTaskService implements PendingInputProbe {

    private static final int SESSION_LIMIT = 10;
    private static final int PROCESS_LIMIT = 100;
    private static final String PAUSED_BY_STOP = "会话已停止，这条消息已暂停发送";

    private final PendingTaskRepository pendingTasks;
    private final PendingAttachmentStore attachments;

    /** 正在派发的任务 id；不落库，进程崩溃后行回到 PENDING 再被启动流程刷成待确认。 */
    private final Set<Long> claiming = new HashSet<>();
    /** 会话 → 最近一次「让位」的执行序号，取消最后一条时可唤醒它继续续跑。 */
    private final Map<Long, Long> deferred = new HashMap<>();

    /**
     * 入队：附件先落盘再插行，插行失败就把刚写的文件撤掉。
     *
     * <p>待确认 / 失败暂停期间直接拒绝：否则面板会同时出现「待确认」和「排队中」两种状态，
     * 用户不知道点哪个。会话空闲时的直投不经过这里，不受这条限制。</p>
     */
    public synchronized String enqueue(long sessionId, ChatCommand command) {
        throwIf(command == null, "待发送内容不能为空");
        throwIf(command.imageUrl() != null && !command.imageUrl().isEmpty(),
                "待发送队列暂不支持图片地址，请改用上传图片");
        List<PendingUpload> uploads = toUploads(command.imageFile());
        requireQueueOpen(sessionId);

        long taskId = IdUtil.getSnowflakeNextId();
        List<PendingAttachment> stored = attachments.store(sessionId, taskId, uploads);
        PendingTask task = PendingTask.enqueue(taskId, sessionId, command.input(), stored,
                command.modelId(), command.agentId(), command.workspaceId(), command.requirePlan(),
                Instant.now());
        try {
            pendingTasks.save(task);
        } catch (RuntimeException failure) {
            // 行没进去，磁盘上的文件就再没有引用者，立刻撤掉。
            attachments.deleteTask(sessionId, taskId);
            throw failure;
        }
        return String.valueOf(taskId);
    }

    @Override
    public synchronized boolean hasPending(long sessionId) {
        return pendingTasks.existsBySession(sessionId);
    }

    public synchronized PendingTaskSnapshot snapshot(long sessionId) {
        List<PendingTask> tasks = pendingTasks.findBySession(sessionId);
        if (tasks.isEmpty()) {
            return new PendingTaskSnapshot(false, null, List.of());
        }
        List<PendingTaskSnapshot.Entry> entries = new ArrayList<>(tasks.size());
        PendingTask paused = null;
        for (PendingTask task : tasks) {
            if (paused == null && task.getStatus() == PendingTaskStatus.PAUSED) {
                paused = task;
            }
            entries.add(new PendingTaskSnapshot.Entry(String.valueOf(task.getId()), task.getInput(),
                    claiming.contains(task.getId()),
                    task.getAttachments().stream()
                            .map(attachment -> new PendingTaskSnapshot.Attachment(attachment.id(), attachment.name()))
                            .toList(),
                    task.getStatus().name()));
        }
        return new PendingTaskSnapshot(paused != null, paused == null ? null : paused.getFailure(),
                List.copyOf(entries));
    }

    /** 撤销一条：先删行再删文件（文件删失败只是垃圾，行留着才是错）。队列空了返回可唤醒的执行序号。 */
    public synchronized Long cancel(long sessionId, String pendingId) {
        long taskId = parseTaskId(pendingId);
        throwIf(claiming.contains(taskId), "这条消息正在发送");
        PendingTask task = pendingTasks.findById(taskId)
                .orElseThrow(() -> new ClientException("待发送消息不存在或已发送"));
        
        pendingTasks.delete(task);
        attachments.deleteTask(sessionId, taskId);
        return pendingTasks.existsBySession(sessionId) ? null : deferred.remove(sessionId);
    }

    /** 用户点「继续」：待确认或失败暂停的那条回到可派发状态。 */
    public synchronized void confirm(long sessionId, String pendingId) {
        PendingTask task = requireTask(sessionId, pendingId);
        task.resume(Instant.now());
        pendingTasks.updateById(task);
    }

    /**
     * 读一条排队附件的字节：缩略图与「回填编辑」共用。
     *
     * <p>必须校验附件确实属于该会话的该条任务 —— 附件 id 是可猜的十六位串，
     * 不校验就能拿别的会话的图片地址。
     */
    public synchronized PendingAttachmentContent readAttachment(long sessionId, String pendingId,
                                                                 String attachmentId) {
        PendingTask task = requireTask(sessionId, pendingId);
        PendingAttachment attachment = task.getAttachments().stream()
                .filter(item -> item.id().equals(attachmentId))
                .findFirst()
                .orElseThrow(() -> new ClientException("待发送图片不存在或已发送"));
        return new PendingAttachmentContent(attachment.name(), attachment.mime(),
                attachments.read(attachment));
    }

    /**
     * 原地修改：文本可改、已上传的图可保留、也可再补新图。
     *
     * <p>顺序不能反：新文件先落盘、库更新成功、最后才删被过滤掉的旧文件。
     * 反过来做一旦库更新失败，用户就永久丢了那几张还能用的图。</p>
     */
    public synchronized void update(long sessionId, String pendingId, String input,
                                    List<String> keepAttachmentIds, List<MultipartFile> files) {
        PendingTask task = requireTask(sessionId, pendingId);
        throwIf(claiming.contains(task.getId()), "这条消息正在发送");

        List<PendingAttachment> existing = task.getAttachments();
        List<PendingAttachment> kept = keepAttachmentIds == null ? existing : existing.stream()
                .filter(attachment -> keepAttachmentIds.contains(attachment.id()))
                .toList();
        List<PendingUpload> uploads = toUploads(files);
        List<PendingAttachment> stored = attachments.store(sessionId, task.getId(), uploads);

        List<PendingAttachment> merged = new ArrayList<>(kept);
        merged.addAll(stored);
        String nextInput = input == null || input.isBlank() ? task.getInput() : input;
        throwIf(nextInput == null || nextInput.isBlank(), "待发送内容不能为空");

        Instant now = Instant.now();
        task.changeInput(nextInput, now);
        task.changeAttachments(merged, now);
        try {
            pendingTasks.updateById(task);
        } catch (RuntimeException failure) {
            // 库没更新成功：这次新写的文件与任务行不再对应，撤掉，旧集合保持原样。
            attachments.deleteAttachments(sessionId, task.getId(),
                    stored.stream().map(PendingAttachment::id).toList());
            throw failure;
        }

        if (keepAttachmentIds != null) {
            List<String> removed = existing.stream()
                    .filter(attachment -> !keepAttachmentIds.contains(attachment.id()))
                    .map(PendingAttachment::id)
                    .toList();
            if (!removed.isEmpty()) {
                attachments.deleteAttachments(sessionId, task.getId(), removed);
            }
        }
    }

    /** 会话被停止：队头暂停，整队随之停摆（派发严格按 id 升序）。 */
    public synchronized void pause(long sessionId) {
        PendingTask head = earliestPending(sessionId);
        if (head == null) {
            return;
        }
        head.pause(PAUSED_BY_STOP, Instant.now());
        pendingTasks.updateById(head);
    }

    /** 队列级恢复：把队头那条失败 / 待确认的任务放回 PENDING。 */
    public synchronized void resume(long sessionId) {
        List<PendingTask> tasks = pendingTasks.findBySession(sessionId);
        for (PendingTask task : tasks) {
            if (task.getStatus() == PendingTaskStatus.PENDING) {
                continue;
            }
            task.resume(Instant.now());
            pendingTasks.updateById(task);
            return;
        }
    }

    /** 认领最早一条可派发任务；没有就返回空。认领只影响快照展示，不落库。 */
    public synchronized Optional<PendingTask> claim(long sessionId) {
        Optional<PendingTask> task = pendingTasks.findEarliestDispatchable(sessionId);
        task.ifPresent(claimed -> claiming.add(claimed.getId()));
        return task;
    }

    /** 派发结束（成功或失败）都要放开认领标记。 */
    public synchronized void released(long taskId) {
        claiming.remove(taskId);
    }

    public synchronized void fail(long sessionId, long taskId, String reason) {
        Optional<PendingTask> found = pendingTasks.findById(taskId);
        if (found.isEmpty()) {
            return;
        }
        PendingTask task = found.get();
        task.fail(reason, Instant.now());
        pendingTasks.updateById(task);
    }

    /** 会话删除：行与磁盘一起清。 */
    public synchronized void clear(long sessionId) {
        pendingTasks.deleteBySession(sessionId);
        attachments.deleteSession(sessionId);
    }

    /** 让位判据：还有待发送任务时，邮件 / 后台任务续跑必须等用户先处理完。 */
    public synchronized boolean deferAutomatic(long sessionId, long executionId) {
        if (!pendingTasks.existsBySession(sessionId)) {
            return false;
        }
        deferred.merge(sessionId, executionId, Math::max);
        return true;
    }

    public synchronized List<Long> dispatchableSessions() {
        return pendingTasks.findDispatchableSessions();
    }

    private void requireQueueOpen(long sessionId) {
        List<PendingTask> tasks = pendingTasks.findBySession(sessionId);
        for (PendingTask task : tasks) {
            if (task.getStatus() == PendingTaskStatus.AWAITING_CONFIRM) {
                throw new ClientException("该会话有上次未发送的消息，请先继续或撤销");
            }
            if (task.getStatus() == PendingTaskStatus.PAUSED) {
                throw new ClientException("该会话有待发送消息发送失败，请先继续或撤销");
            }
        }
        throwIf(tasks.size() >= SESSION_LIMIT, "当前会话最多可以排队 " + SESSION_LIMIT + " 条消息");
        throwIf(pendingTasks.countAll() >= PROCESS_LIMIT, "待发送队列已满，请稍后再试");
    }

    private PendingTask requireTask(long sessionId, String pendingId) {
        PendingTask task = pendingTasks.findById(parseTaskId(pendingId))
                .orElseThrow(() -> new ClientException("待发送消息不存在或已发送"));
        throwIf(task.getSessionId() != sessionId, "待发送消息不属于该会话");
        return task;
    }

    private PendingTask earliestPending(long sessionId) {
        return pendingTasks.findBySession(sessionId).stream()
                .filter(task -> task.getStatus() == PendingTaskStatus.PENDING)
                .min(Comparator.comparingLong(PendingTask::getId))
                .orElse(null);
    }

    /** 上传内容先读成字节：请求一结束 {@code MultipartFile} 就失效了。 */
    private List<PendingUpload> toUploads(List<MultipartFile> files) {
        if (files == null || files.isEmpty()) {
            return List.of();
        }
        List<PendingUpload> uploads = new ArrayList<>();
        for (MultipartFile file : files) {
            if (file == null || file.isEmpty()) {
                continue;
            }
            String mime = file.getContentType();
            throwIf(mime == null || !mime.startsWith("image/"), "只支持上传图片文件");
            try {
                uploads.add(new PendingUpload(file.getOriginalFilename(), mime, file.getBytes()));
            } catch (IOException failure) {
                throw new ClientException("读取上传图片失败");
            }
        }
        throwIf(uploads.size() > SessionMessage.MAX_IMAGE_COUNT,
                "每条消息最多上传 " + SessionMessage.MAX_IMAGE_COUNT + " 张图片");
        return uploads;
    }

    private long parseTaskId(String pendingId) {
        try {
            return Long.parseLong(pendingId);
        } catch (NumberFormatException invalid) {
            throw new ClientException("待发送消息标识不合法: " + pendingId);
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }
}
