package com.summit.dp.execution.infrastructure.checkpoint;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore.CheckpointWriter;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalCheckpointMaintenance;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 在途登记竞态（复核报告 R1）的回归守卫。
 *
 * <p>被守的缺陷：{@code release} 里「移除自己的标识 → 判空 → 移除键」三步不原子，
 * 合法交错会让 A 结束时把含 B 新登记的整个集合移除，清理器随后把 B 已发布未提交的正文
 * 当孤儿删掉，B 提交后留下断链引用（{@code BUG_REPRODUCED=UNSETTLED_CHECKPOINT_DELETED}）。</p>
 *
 * <p>这里不改产品语义，只在「释放窗口」这一个原子步骤内部插调度点，让交错<b>确定性</b>发生，
 * 而不是靠循环碰运气。写入句柄的读锁按线程持有，所以 begin 与 complete 都放在同一个单线程池里。</p>
 */
class CheckpointInFlightRegistryTest {

    private static final String EXECUTION_ID = "900001";

    @TempDir
    Path dataDir;

    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    private LocalFileCheckpointStore store;
    private LocalCheckpointMaintenance maintenance;
    /** 两笔写入各用一个单线程池：读锁按线程持有，begin 与 complete 必须同线程。 */
    private ExecutorService firstWriter;
    private ExecutorService secondWriter;

    @BeforeEach
    void setUp() {
        store = new LocalFileCheckpointStore(dataDir.toString(), mapper, 0L);
        ExecutionRepository repository = mock(ExecutionRepository.class);
        // 库里没有这一行：这条执行的正文在清理器眼里全是孤儿，只有「在途登记」能保护它们。
        when(repository.findSnapshotFileIds(any(java.util.Collection.class))).thenReturn(Map.of());
        maintenance = new LocalCheckpointMaintenance(store, repository);
        firstWriter = Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "checkpoint-a"));
        secondWriter = Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "checkpoint-b"));
    }

    @AfterEach
    void shutdown() {
        store.setReleaseWindowHook(null);
        firstWriter.shutdownNow();
        secondWriter.shutdownNow();
    }

    /**
     * 确定性交错：A 卡在「已移除自己的标识、尚未提交集合新状态」的窗口里，B 同时开始写入。
     *
     * <p>修好后 B 的登记必然被挡在同一个 key 的原子步骤外 —— 它既进不来窗口，
     * 也就不会被 A 的收尾连带移除；清理器仍能看到 B 的在途登记，不会误删它的正文。</p>
     */
    @Test
    void releasingOneWriteCannotDropAnotherWritesRegistration() throws Exception {
        CountDownLatch insideRelease = new CountDownLatch(1);
        CountDownLatch allowReleaseToFinish = new CountDownLatch(1);
        store.setReleaseWindowHook(() -> {
            insideRelease.countDown();
            awaitQuietly(allowReleaseToFinish);
        });

        // A：写入 → 发布 → 提交回调（complete 走 release），整笔在同一个线程里。
        Future<?> releasing = firstWriter.submit(() -> {
            publish("A").complete();
            return null;
        });
        assertTrue(insideRelease.await(10, TimeUnit.SECONDS), "释放必须进入原子步骤的窗口");

        Future<CheckpointWriter> beginning = secondWriter.submit(() -> publish("B"));
        // 关键断言：窗口内登记进不来（同一个 key 的 compute 互斥）。旧实现在这里会放行，
        // 随后 A 的 remove(executionId, 集合) 把 B 的登记一起抹掉。
        assertThrows(TimeoutException.class, () -> beginning.get(300, TimeUnit.MILLISECONDS));
        assertFalse(beginning.isDone(), "B 不能被放行进入 A 尚未完成的原子步骤");

        allowReleaseToFinish.countDown();
        CheckpointWriter second = beginning.get(10, TimeUnit.SECONDS);
        releasing.get(10, TimeUnit.SECONDS);

        assertEquals(Set.of(second.fileId()), store.inFlightFileIds(EXECUTION_ID),
                "A 结束时只允许移除自己的登记，B 的登记必须原样保留");

        // 清理器按在途登记跳过：B 已发布未提交的正文不能被当孤儿删掉。
        maintenance.reclaimUnreferenced(10, 10);
        assertTrue(Files.isRegularFile(fileOf(second)), "B 已发布未提交的正文被清理器误删了（断链引用的前一步）");

        secondWriter.submit(second::complete).get(10, TimeUnit.SECONDS);
        assertTrue(store.inFlightFileIds(EXECUTION_ID).isEmpty(), "B 结束后登记必须清空");
    }

    /** 「提交回调与下一次 begin 交错」的循环守卫：每轮都必须保住新一轮的登记与正文。 */
    @Test
    void completingOneWriteWhileTheNextBeginsKeepsRegistryConsistent() throws Exception {
        for (int round = 0; round < 60; round++) {
            final int roundIndex = round;
            CyclicBarrier barrier = new CyclicBarrier(2);
            Future<CheckpointWriter> completing = firstWriter.submit(() -> {
                CheckpointWriter previous = publish("round-" + roundIndex);
                barrier.await(10, TimeUnit.SECONDS);
                previous.complete();
                return previous;
            });
            Future<CheckpointWriter> beginning = secondWriter.submit(() -> {
                barrier.await(10, TimeUnit.SECONDS);
                return publish("round-" + roundIndex + "-next");
            });
            completing.get(30, TimeUnit.SECONDS);
            CheckpointWriter next = beginning.get(30, TimeUnit.SECONDS);

            assertEquals(Set.of(next.fileId()), store.inFlightFileIds(EXECUTION_ID),
                    "上一笔结束不能连带移除下一笔的登记, round=" + roundIndex);
            maintenance.reclaimUnreferenced(10, 10);
            assertTrue(Files.isRegularFile(fileOf(next)), "在途正文不能被清理器删掉, round=" + roundIndex);

            secondWriter.submit(next::complete).get(30, TimeUnit.SECONDS);
            assertTrue(store.inFlightFileIds(EXECUTION_ID).isEmpty(), "本轮结束登记必须清空, round=" + roundIndex);
        }
    }

    /** 写入并发布一份正文，返回仍处在途状态的句柄。 */
    private CheckpointWriter publish(String marker) throws IOException {
        CheckpointWriter writer = store.begin(EXECUTION_ID);
        // 与生产一致：直接交给 ObjectMapper 流式写，关闭与发表由 publish() 负责。
        mapper.writeValue(writer.stream(), Map.of("marker", marker));
        writer.publish();
        return writer;
    }

    private Path fileOf(CheckpointWriter writer) {
        return dataDir.resolve("checkpoints").resolve(EXECUTION_ID).resolve(writer.fileId() + ".json");
    }

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            latch.await(20, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
