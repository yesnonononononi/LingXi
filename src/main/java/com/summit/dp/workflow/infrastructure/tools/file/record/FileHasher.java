package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.NonNull;

import java.io.IOException;
import java.nio.file.Path;

public interface FileHasher {

    String hash(@NonNull String content);

    String hashFile(@NonNull Path path) throws IOException;
}
