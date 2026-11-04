package com.summit.dp.execution.qa;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore.CheckpointWriter;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.shared.utils.TestTimeouts;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalCheckpointMaintenance;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 复核 R1 的独立探针：一笔写入结束，绝不能把另一笔未结束写入的在途登记一起抹掉。
 *
 * <p><b>判据取「结果」而不是「锁行为」</b>：只断言最终事实 —— B 的登记还在、B 已发布未提交的
 * 正文没被清理器删掉。锁内部长什么样不关心，换实现只要结果对就继续绿。</p>
 *
 * <p><b>两条互补探针</b>：{@code deterministic…} 用库里的测试接缝（反射安装，生产恒为 null）
 * 把 A 卡在「已移除自己的标识」的瞬间；{@code stress…} 不用任何接缝，靠真实并发交错反复压，
 * 覆盖「接缝本身被删掉」的情形。</p>
 */
class InFlightReleaseRaceProbeTest {

    private static final String EXECUTION_ID = "910001";

    @TempDir
    Path dataDir;

    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    private LocalFileCheckpointStore store;
    private LocalCheckpointMaintenance maintenance;
    private ExecutorService writerA;
    private ExecutorService writerB;

    @BeforeEach
    void setUp() {
        store = new LocalFileCheckpointStore(dataDir.toString(), mapper, 0L);
        ExecutionRepository repository = mock(ExecutionRepository.class);
        // 库里没有这一行：这条执行的正文在清理器眼里全是孤儿，只有「在途登记」能保护它们。
        when(repository.findSnapshotFileIds(any(java.util.Collection.class))).thenReturn(Map.of());
        maintenance = new LocalCheckpointMaintenance(store, repository);
        writerA = Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "probe-a"));
        writerB = Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "probe-b"));
    }

    @AfterEach
    void tearDown() throws Exception {
        installReleaseWindowHook(null);
        writerA.shutdownNow();
        writerB.shutdownNow();
    }

    /** 确定性交错：A 的释放停在自己的窗口里，B 同时在同一个执行上开始写入。 */
    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void deterministicInterleavingKeepsTheOtherWritersRegistrationAndFile() throws Exception {
        CountDownLatch insideRelease = new CountDownLatch(1);
        CountDownLatch letReleaseFinish = new CountDownLatch(1);
        CountDownLatch bStartedWriting = new CountDownLatch(1);
        installReleaseWindowHook(() -> {
            insideRelease.countDown();
            awaitQuietly(letReleaseFinish);
        });

        Future<?> finishingA = writerA.submit(() -> {
            publish("A").complete();
            return null;
        });
        assertTrue(insideRelease.await(10, TimeUnit.SECONDS), "A 必须进入释放窗口");

        // B 开始在同一个执行上写入，并报出「已登记」的时刻：修好后它会卡在同一 key 的原子步骤外，
        // 因此这个信号不会到达（await 超时）；被打穿时它会在窗口内到达。
        Future<CheckpointWriter> startingB = writerB.submit(() -> {
            CheckpointWriter writer = store.begin(EXECUTION_ID);
            bStartedWriting.countDown();
            mapper.writeValue(writer.stream(), Map.of("marker", "B"));
            writer.publish();
            return writer;
        });
        boolean registeredInsideTheWindow = bStartedWriting.await(1, TimeUnit.SECONDS);

        letReleaseFinish.countDown();
        CheckpointWriter b = startingB.get(10, TimeUnit.SECONDS);
        finishingA.get(10, TimeUnit.SECONDS);

        assertFalse(registeredInsideTheWindow,
                "B 的登记落在 A 尚未收尾的窗口里 —— 这正是复核 R1 描述的交错");
        assertEquals(Set.of(b.fileId()), store.inFlightFileIds(EXECUTION_ID),
                "A 结束只允许移除自己的登记，B 的登记必须还在");
        maintenance.reclaimUnreferenced(10, 10);
        assertTrue(Files.isRegularFile(fileOf(b)),
                "B 已发布未提交的正文被当孤儿删掉了 —— 这就是 UNSETTLED_CHECKPOINT_DELETED 的前一步");

        writerB.submit(b::complete).get(10, TimeUnit.SECONDS);
        assertTrue(store.inFlightFileIds(EXECUTION_ID).isEmpty(), "B 结束后登记必须清空");
    }

    /**
     * 无接缝压测：真实并发下反复「一笔结束 / 下一笔开始」。
     *
     * <p>这条不依赖 {@code releaseWindowHook} —— 接缝被删或生产实现被换掉时它仍然有效。
     * 交错窗口很窄，所以靠轮次而不是靠运气：任何一轮丢掉登记或正文就立刻失败。</p>
     */
    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void stressRepeatedCompleteAndBeginNeverLosesThePendingWrite() throws Exception {
        for (int round = 0; round < 150; round++) {
            int index = round;
            CyclicBarrier barrier = new CyclicBarrier(2);
            Future<CheckpointWriter> finishing = writerA.submit(() -> {
                CheckpointWriter previous = publish("finished-" + index);
                barrier.await(10, TimeUnit.SECONDS);
                previous.complete();
                return previous;
            });
            Future<CheckpointWriter> starting = writerB.submit(() -> {
                barrier.await(10, TimeUnit.SECONDS);
                return publish("pending-" + index);
            });
            finishing.get(30, TimeUnit.SECONDS);
            CheckpointWriter pending = starting.get(30, TimeUnit.SECONDS);

            assertEquals(Set.of(pending.fileId()), store.inFlightFileIds(EXECUTION_ID),
                    "上一笔结束不能连带移除下一笔的登记, round=" + index);
            maintenance.reclaimUnreferenced(10, 10);
            assertTrue(Files.isRegularFile(fileOf(pending)),
                    "在途正文不能被清理器删掉, round=" + index);

            writerB.submit(pending::complete).get(30, TimeUnit.SECONDS);
            assertTrue(store.inFlightFileIds(EXECUTION_ID).isEmpty(), "本轮结束登记必须清空, round=" + index);
        }
    }

    /** 反射安装/清除库里的测试接缝：不依赖包可见性，也不改产品代码。 */
    private void installReleaseWindowHook(Runnable hook) throws Exception {
        Method method = LocalFileCheckpointStore.class.getDeclaredMethod("setReleaseWindowHook", Runnable.class);
        method.setAccessible(true);
        method.invoke(store, hook);
    }

    private CheckpointWriter publish(String marker) throws Exception {
        CheckpointWriter writer = store.begin(EXECUTION_ID);
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
