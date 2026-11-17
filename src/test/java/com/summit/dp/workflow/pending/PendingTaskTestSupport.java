package com.summit.dp.workflow.pending;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.application.pending.PendingAttachmentStore;
import com.summit.dp.workflow.application.pending.PendingUpload;
import com.summit.dp.workflow.domain.pending.model.PendingAttachment;
import com.summit.dp.workflow.domain.pending.model.PendingTask;
import com.summit.dp.workflow.domain.pending.model.PendingTaskStatus;
import com.summit.dp.workflow.domain.pending.repo.PendingTaskRepository;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;

/**
 * 待发送队列用例的内存替身。
 *
 * <p><b>不模拟事务语义</b>：这里只保证「读写顺序与仓储一致」，同事务失败回滚由真实事务的
 * 用例验证 —— 用内存替身去验事务，等于自己给自己发合格证。</p>
 */
public final class PendingTaskTestSupport {

    private PendingTaskTestSupport() {
    }

    /** 内存仓储：按 id 升序返回，与 {@code order by id} 对齐。 */
    public static final class InMemoryRepository implements PendingTaskRepository {
        private final Map<Long, PendingTask> rows = new LinkedHashMap<>();
        private boolean failOnDelete;

        /** 让删除动作失败，用来验证「删任务行必须在新轮次落库同一事务里」。 */
        public void failOnDelete() {
            this.failOnDelete = true;
        }

        public int size() {
            return rows.size();
        }

        @Override
        public void save(PendingTask entity) {
            rows.put(entity.getId(), entity);
        }

        @Override
        public void delete(PendingTask entity) {
            if (failOnDelete) {
                throw new ClientException("删除待发送任务失败");
            }
            rows.remove(entity.getId());
        }

        @Override
        public Optional<PendingTask> findById(Long id) {
            return Optional.ofNullable(rows.get(id));
        }

        @Override
        public void updateById(PendingTask entity) {
            rows.put(entity.getId(), entity);
        }

        @Override
        public void update(Collection<PendingTask> list) {
            list.forEach(this::updateById);
        }

        @Override
        public IPage<PendingTask> queryByPage(int current, int size) {
            throw new UnsupportedOperationException("测试替身不支持分页");
        }

        @Override
        public List<PendingTask> findBySession(long sessionId) {
            return rows.values().stream()
                    .filter(task -> task.getSessionId() == sessionId)
                    .sorted(Comparator.comparingLong(PendingTask::getId))
                    .toList();
        }

        @Override
        public Optional<PendingTask> findEarliestDispatchable(long sessionId) {
            return findBySession(sessionId).stream().filter(PendingTask::dispatchable).findFirst();
        }

        @Override
        public boolean existsBySession(long sessionId) {
            return rows.values().stream().anyMatch(task -> task.getSessionId() == sessionId);
        }

        @Override
        public int countBySession(long sessionId) {
            return (int) rows.values().stream().filter(task -> task.getSessionId() == sessionId).count();
        }

        @Override
        public int countAll() {
            return rows.size();
        }

        @Override
        public List<Long> findDispatchableSessions() {
            return rows.values().stream().filter(PendingTask::dispatchable)
                    .map(PendingTask::getSessionId).distinct().toList();
        }

        @Override
        public int markLegacyAwaitingConfirm() {
            int changed = 0;
            for (PendingTask task : rows.values()) {
                if (task.getStatus() == PendingTaskStatus.PENDING) {
                    task.markAwaitingConfirm(Instant.now());
                    changed++;
                }
            }
            return changed;
        }

        @Override
        public int deleteBySession(long sessionId) {
            List<Long> doomed = rows.values().stream()
                    .filter(task -> task.getSessionId() == sessionId)
                    .map(PendingTask::getId).toList();
            doomed.forEach(rows::remove);
            return doomed.size();
        }
    }

    /** 内存附件存储：key 是 relPath，值就是字节。 */
    public static final class InMemoryAttachmentStore implements PendingAttachmentStore {
        private final Map<String, byte[]> files = new TreeMap<>();
        private long counter;

        @Override
        public List<PendingAttachment> store(long sessionId, long taskId, List<PendingUpload> uploads) {
            List<PendingAttachment> stored = new ArrayList<>();
            for (PendingUpload upload : uploads) {
                String extension = extensionOf(upload.mime());
                if (extension == null) {
                    throw new ClientException("暂不支持的图片格式: " + upload.mime());
                }
                String id = String.format("%016x", ++counter);
                String relPath = sessionId + "/" + taskId + "/" + id + "." + extension;
                files.put(relPath, upload.data());
                stored.add(new PendingAttachment(id, upload.name(), upload.mime(), upload.data().length, relPath));
            }
            return List.copyOf(stored);
        }

        @Override
        public byte[] read(PendingAttachment attachment) {
            byte[] data = files.get(attachment.relPath());
            if (data == null) {
                throw new ClientException("待发送图片已丢失，请重新上传: " + attachment.name());
            }
            return data;
        }

        @Override
        public void deleteTask(long sessionId, long taskId) {
            String prefix = sessionId + "/" + taskId + "/";
            files.keySet().removeIf(key -> key.startsWith(prefix));
        }

        @Override
        public void deleteSession(long sessionId) {
            String prefix = sessionId + "/";
            files.keySet().removeIf(key -> key.startsWith(prefix));
        }

        @Override
        public void deleteAttachments(long sessionId, long taskId, Collection<String> attachmentIds) {
            String prefix = sessionId + "/" + taskId + "/";
            // 与磁盘实现同口径：附件 id 是文件名去扩展名，不是整个 relPath 的后缀。
            files.keySet().removeIf(key -> key.startsWith(prefix) && attachmentIds.contains(fileId(key)));
        }

        private static String fileId(String relPath) {
            String name = relPath.substring(relPath.lastIndexOf('/') + 1);
            int dot = name.lastIndexOf('.');
            return dot > 0 ? name.substring(0, dot) : name;
        }

        @Override
        public long usedBytes(long sessionId) {
            String prefix = sessionId + "/";
            return files.entrySet().stream()
                    .filter(entry -> entry.getKey().startsWith(prefix))
                    .mapToLong(entry -> entry.getValue().length).sum();
        }

        /** 现有文件数（断言「被过滤的图真的删了」用）。 */
        public int fileCount() {
            return files.size();
        }

        public Set<String> relPaths() {
            return files.keySet();
        }

        private static String extensionOf(String mime) {
            if (mime == null) {
                return null;
            }
            return switch (mime.toLowerCase()) {
                case "image/png" -> "png";
                case "image/jpeg" -> "jpg";
                case "image/webp" -> "webp";
                case "image/gif" -> "gif";
                default -> null;
            };
        }
    }
}
