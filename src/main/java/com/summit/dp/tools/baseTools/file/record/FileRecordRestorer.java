package com.summit.dp.tools.baseTools.file.record;

import com.summit.dp.tools.baseTools.file.record.FileModificationException;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.dp.tools.baseTools.file.record.FileHasher;
import com.summit.dp.tools.baseTools.file.record.FileRecord;
import lombok.RequiredArgsConstructor;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.file.Path;
import java.util.Objects;

/**
 * Performs the physical part of a reject: verifies the file is still in the
 * state the edit left it in (hash check) and then restores the previous
 * content, or deletes the file when the edit created it. All IO goes through
 * the workspace bridge so it lands in the same environment (local or sandbox)
 * the edit was applied in.
 */
@RequiredArgsConstructor
public class FileRecordRestorer {

    private final FileHasher fileHasher;

    /**
     * Restores the file of the given record to its pre-edit state.
     *
     * @throws FileModificationException on hash mismatch, missing file or IO failure
     */
    public void restore(FileRecord record, Workspace workspace) throws FileModificationException {
        WorkspaceBridge bridge = workspace.bridge();
        Charset charset = workspace.runtimeEnvironment().charset();
        Path path = workspace.resolve(record.filePath());
        try {
            // if the record has no old content, the file was created by the edit and should be deleted
            if (record.oldContent() == null) {
                this.deleteCreatedFile(bridge, record, path);
                return;
            }
            // if the file was modified, the edit failed and should not be rejected
            this.requireUnchanged(bridge, record, path, charset);
            bridge.writeString(path, record.oldContent(), charset);
        } catch (IOException e) {
            throw new FileModificationException(
                    "failed to restore " + record.filePath() + " for record " + record.id() + ": " + e.getMessage());
        }
    }

    private void deleteCreatedFile(WorkspaceBridge bridge, FileRecord record, Path path) throws IOException {
        if (!bridge.exists(path)) {
            throw new FileModificationException("cannot reject record " + record.id()
                    + ": created file " + record.filePath() + " no longer exists");
        }
        bridge.deleteFile(path);
    }

    /**
     * Verifies the file is still in the state the edit left it in.
     * @param bridge workspace bridge
     * @param record file record
     * @param path file path
     * @param charset file charset
     */
    private void requireUnchanged(WorkspaceBridge bridge, FileRecord record, Path path, Charset charset)
            throws IOException {
        if (!bridge.exists(path)) {
            throw new FileModificationException("cannot reject record " + record.id()
                    + ": file " + record.filePath() + " no longer exists");
        }
        String current = bridge.readString(path, charset);
        if (!Objects.equals(this.fileHasher.hash(current), record.newContentHash())) {
            throw new FileModificationException("cannot reject record " + record.id() + ": file "
                    + record.filePath() + " was modified after the edit (content hash mismatch)");
        }
    }
}
