package com.summit.dp.workflow.infrastructure.tools.file.record;

import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import lombok.RequiredArgsConstructor;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Objects;

/** 还原必须走原 Workspace，避免把沙箱修改写入本机。 */
@RequiredArgsConstructor
public class FileRecordRestorer {

    private final FileHasher fileHasher;

    /** 还原前检查当前内容，不能覆盖编辑后产生的新修改。 */
    public void restore(FileRecord record, Workspace workspace) throws FileModificationException {
        WorkspaceFiles files = workspace.bridge().files();
        Charset charset = StandardCharsets.UTF_8;
        Path path = workspace.resolve(record.filePath());
        try {
            // 无旧内容表示本次新建，拒绝时要删除文件。
            if (record.oldContent() == null) {
                this.deleteCreatedFile(files, record, path);
                return;
            }
            // 后续修改不能被旧记录的回滚覆盖。
            this.requireUnchanged(files, record, path, charset);
            files.writeString(path, record.oldContent(), charset);
        } catch (IOException e) {
            throw new FileModificationException(
                    "failed to restore " + record.filePath() + " for record " + record.id() + ": " + e.getMessage());
        }
    }

    private void deleteCreatedFile(WorkspaceFiles files, FileRecord record, Path path) throws IOException {
        if (!files.exists(path)) {
            throw new FileModificationException("cannot reject record " + record.id()
                    + ": created file " + record.filePath() + " no longer exists");
        }
        files.deleteFile(path);
    }

    private void requireUnchanged(WorkspaceFiles files, FileRecord record, Path path, Charset charset)
            throws IOException {
        if (!files.exists(path)) {
            throw new FileModificationException("cannot reject record " + record.id()
                    + ": file " + record.filePath() + " no longer exists");
        }
        String current = files.readString(path, charset);
        if (!Objects.equals(this.fileHasher.hash(current), record.newContentHash())) {
            throw new FileModificationException("cannot reject record " + record.id() + ": file "
                    + record.filePath() + " was modified after the edit (content hash mismatch)");
        }
    }
}
