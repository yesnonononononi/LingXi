package com.summit.dp.tools.baseTools.file.record;

import lombok.NonNull;

import java.io.IOException;
import java.nio.file.Path;

/**
 * Compute content/file hashes used for conflict detection before applying patches.
 */
public interface FileHasher {

    /**
     * Compute the hash of the given text content.
     *
     * @param content the text content
     * @return the hash of the content as a hex string
     */
    String hash(@NonNull String content);

    /**
     * Compute the hash of the content of the file located at the given path.
     *
     * @param path the path to the file
     * @return the hash of the file content as a hex string
     * @throws IOException if the file cannot be read
     */
    String hashFile(@NonNull Path path) throws IOException;
}
