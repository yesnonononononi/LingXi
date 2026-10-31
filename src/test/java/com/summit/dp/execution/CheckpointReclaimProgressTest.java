package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.application.port.ExecutionCheckpointMaintenance;
import com.summit.dp.execution.application.port.ExecutionCheckpointMaintenance.FileReclaimResult;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalCheckpointMaintenance;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collection;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 检查点文件回收的两个「预算/目录」边界：空目录回收与跨调用枚举推进。
 *
 * <p>典型失效现场（两个缺陷都必须在这里变红）：</p>
 * <ol>
 *   <li>正文删完只留下空执行目录，每轮执行多一个，{@code checkpoints/} 堆到几千个；</li>
 *   <li>枚举每轮都从最小 id 重扫固定预算，前 N 个目录一直占着预算，
 *       更大 id 里的孤儿文件与 {@code .part} 残留永远扫不到。</li>
 * </ol>
 */
class CheckpointReclaimProgressTest {

    private static final int FILE_ID_LENGTH = 32;

    @TempDir
    Path dataDir;

    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    private final Map<Long, String> referencedFiles = new HashMap<>();
    private LocalFileCheckpointStore store;
    private ExecutionCheckpointMaintenance maintenance;

    @BeforeEach
    void setUp() {
        store = new LocalFileCheckpointStore(dataDir.toString(), mapper, 0L);
        ExecutionRepository repository = mock(ExecutionRepository.class);
        // 只认登记过的「库内权威引用」；其余执行在库里没有行，目录里的文件都是孤儿。
        when(repository.findSnapshotFileIds(any(Collection.class))).thenAnswer(invocation -> {
            Collection<Long> ids = invocation.getArgument(0);
            Map<Long, String> referenced = new HashMap<>();
            for (Long id : ids) {
                String fileId = referencedFiles.get(id);
                if (fileId != null) {
                    referenced.put(id, fileId);
                }
            }
            return referenced;
        });
        maintenance = new LocalCheckpointMaintenance(store, repository);
    }

    @Test
    void lastFileDeletionAlsoReclaimsTheEmptyExecutionDirectory() throws IOException {
        Path directory = createDirectory(700);
        String orphan = fileId(7);
        Files.writeString(directory.resolve(orphan + ".json"), "{\"orphan\":true}");

        FileReclaimResult result = maintenance.reclaimUnreferenced(10, 10);

        assertEquals(1, result.deletedFiles());
        assertEquals(1, result.deletedDirectories());
        assertFalse(Files.exists(directory), "最后一份正文删掉后，执行目录必须一起回收");
    }

    @Test
    void leftoverEmptyDirectoryIsReclaimedEvenWithoutAnyFile() throws IOException {
        // 缺陷现场：正文早被删掉，只剩一个空目录（旧实现永远不会再看它一眼）。
        Path directory = createDirectory(701);
        assertTrue(Files.isDirectory(directory));

        FileReclaimResult result = maintenance.reclaimUnreferenced(10, 10);

        assertEquals(0, result.deletedFiles());
        assertEquals(1, result.deletedDirectories(), "历史遗留的空执行目录必须被回收");
        assertFalse(Files.exists(directory));
    }

    @Test
    void directoriesWithReferencedBodiesAreNeverRemoved() throws IOException {
        Path directory = createDirectory(702);
        String referenced = fileId(1);
        Files.writeString(directory.resolve(referenced + ".json"), "{\"keep\":true}");
        referencedFiles.put(702L, referenced);

        FileReclaimResult result = maintenance.reclaimUnreferenced(10, 10);

        assertEquals(0, result.deletedFiles());
        assertEquals(0, result.deletedDirectories());
        assertTrue(Files.isRegularFile(directory.resolve(referenced + ".json")), "库内权威引用的正文不能删");
        assertTrue(Files.isDirectory(directory), "非空目录不能被当成空目录删掉");
    }

    @Test
    void otherDataDirectoriesUnderDataDirAreNotTouched() throws IOException {
        Path images = Files.createDirectories(dataDir.resolve("images"));
        Path image = Files.writeString(images.resolve("cat.png"), "not-a-real-image");
        Path emptySkill = Files.createDirectories(dataDir.resolve("skill"));

        maintenance.reclaimUnreferenced(10, 10);

        assertTrue(Files.isRegularFile(image), "数据目录里的其它内容一律不碰");
        assertTrue(Files.isDirectory(emptySkill), "只回收 checkpoints 下的执行目录，不碰空 skill 目录");
    }

    /**
     * 缺陷②的正面对撞：目录总数超过单轮预算，且前若干目录是「有正文的活目录」，
     * 永远占着预算；更大 id 里的孤儿文件与 {@code .part} 必须靠跨调用推进才能扫到。
     */
    @Test
    void orphanAndTemporaryFilesBeyondSinglePassBudgetAreEventuallyReclaimed() throws IOException {
        int budget = 3;
        int liveDirectories = 3;
        int garbageDirectories = 7;
        // 前 3 个目录：正文被库内权威引用，删不掉也留得住，每轮都会重新占用预算。
        for (int index = 1; index <= liveDirectories; index++) {
            Path directory = createDirectory(800 + index);
            String referenced = fileId(index);
            Files.writeString(directory.resolve(referenced + ".json"), "{\"live\":true}");
            referencedFiles.put(800L + index, referenced);
        }
        // 后面 7 个目录：交替放孤儿正文与未完成的 .part。
        for (int index = 0; index < garbageDirectories; index++) {
            Path directory = createDirectory(900 + index);
            String orphan = fileId(100 + index);
            if (index % 2 == 0) {
                Files.writeString(directory.resolve(orphan + ".json"), "{\"orphan\":true}");
            } else {
                Files.writeString(directory.resolve(orphan + "-unfinished.part"), "{");
            }
        }

        int rounds = 0;
        int reclaimedDirectories = 0;
        while (rounds < 20 && countGarbageDirectories() > 0) {
            FileReclaimResult result = maintenance.reclaimUnreferenced(budget, 10);
            reclaimedDirectories += result.deletedDirectories();
            rounds++;
        }

        assertEquals(0, countGarbageDirectories(), "目录数超过单轮预算时，孤儿文件与 .part 必须最终被回收");
        assertEquals(garbageDirectories, reclaimedDirectories, "清空的执行目录要一起回收");
        // 3 个活目录 + 7 个垃圾目录、每轮预算 3 个：ceil(10/3)+1 = 5 轮内必须收敛。
        assertTrue(rounds <= 5, "游标必须推进，实际轮数=" + rounds);
        for (int index = 1; index <= liveDirectories; index++) {
            Path directory = dataDir.resolve("checkpoints").resolve(Integer.toString(800 + index));
            assertTrue(Files.isRegularFile(directory.resolve(fileId(index) + ".json")),
                    "库内权威引用的正文不能被回收: executionId=" + (800 + index));
        }
    }

    /** 空目录不会再随「保存 → 清理」循环堆积：每轮补一个目录，清理后目录数必须回到 0。 */
    @Test
    void repeatedSaveThenCleanupCyclesDoNotAccumulateDirectories() throws IOException {
        for (int cycle = 1; cycle <= 5; cycle++) {
            Path directory = createDirectory(1000 + cycle);
            Files.writeString(directory.resolve(fileId(cycle) + ".json"), "{\"orphan\":true}");

            maintenance.reclaimUnreferenced(400, 50);

            try (Stream<Path> children = Files.list(dataDir.resolve("checkpoints"))) {
                assertEquals(0, children.count(), "保存→清理循环不能让空执行目录越堆越多, cycle=" + cycle);
            }
        }
    }

    private Path createDirectory(long executionId) throws IOException {
        return Files.createDirectories(dataDir.resolve("checkpoints").resolve(Long.toString(executionId)));
    }

    private long countGarbageDirectories() throws IOException {
        try (Stream<Path> children = Files.list(dataDir.resolve("checkpoints"))) {
            return children.filter(Files::isDirectory)
                    .filter(path -> {
                        String name = path.getFileName().toString();
                        return !name.startsWith("80") && !name.startsWith("702");
                    })
                    .count();
        }
    }

    private static String fileId(int seed) {
        return String.format(Locale.ROOT, "%0" + FILE_ID_LENGTH + "d", seed);
    }
}
