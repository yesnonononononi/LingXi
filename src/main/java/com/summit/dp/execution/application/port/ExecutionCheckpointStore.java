package com.summit.dp.execution.application.port;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Set;

/**
 * 执行检查点正文的存储端口（业务侧）。
 *
 * <p><b>为什么要有这个端口</b>：检查点是「毫秒级频繁保存 + 体积可达数百 MB」的数据，
 * 放在数据库列里既要整段字符串进出堆，又让事务时长被写盘拖长。正文改存文件后，
 * 「文件命名、路径校验、流式 JSON、临时文件发布、删除」全部收敛在这一个实现里，
 * 恢复、审批、重发各入口只拿文件标识，不各写一套文件逻辑。</p>
 *
 * <p><b>文件标识只是存储定位信息</b>，不替换 {@code executionId} / {@code sessionId} /
 * {@code turnId}；前后端 ID 契约不变。</p>
 *
 * <p>目录布局：{@code <数据目录>/checkpoints/<executionId>/<文件标识>.json}。</p>
 */
public interface ExecutionCheckpointStore {

    /**
     * 开始写入一个新的检查点文件（尚未发布）。
     *
     * <p>实现必须：建独立临时文件 → 登记「在途写入」→ 返回可流式写入的句柄。
     * 发布之前任何读取方都看不到这份正文。</p>
     *
     * @param executionId 执行标识；必须是数字串（实现负责校验，禁止路径穿越）
     * @return 写入句柄，必须 {@link CheckpointWriter#close()}
     */
    CheckpointWriter begin(String executionId);

    /**
     * 按数据库里的权威引用读取正文，并在流有效期内完成反序列化。
     *
     * <p>每次调用返回<b>独立可变</b>对象：文件本身不被内存副本兜着，
     * 修改返回值不会影响已提交内容。</p>
     *
     * @throws IllegalStateException 文件不存在或无法解析（明确失败，不静默改读旧版本）
     */
    <T> T read(String executionId, String fileId, Class<T> type);

    /**
     * 删除某个检查点文件。
     *
     * <p>在途写入的文件不会被删除（返回 {@code false}）；删除失败只记录不抛出 ——
     * 调用方已经提交成功，不能把「旧文件删不掉」伪报成保存失败，留给后续手动清理。</p>
     *
     * @return 是否确实删除了文件
     */
    boolean delete(String executionId, String fileId);

    /** 该文件是否仍在写入中（供清理跳过未完成的写入）。 */
    boolean isInFlight(String executionId, String fileId);

    /** 当前在途写入的文件标识快照；清理逻辑按它跳过。 */
    Set<String> inFlightFileIds(String executionId);

    /** 流式写入句柄：持有临时文件与在途登记，直到发布或丢弃。 */
    interface CheckpointWriter extends AutoCloseable {

        /** 流式写入口；调用方应直接交给 {@code ObjectMapper.writeValue(OutputStream, ...)}。 */
        OutputStream stream();

        /** 本次写入的文件标识（发布后成为数据库里的权威引用）。 */
        String fileId();

        /**
         * 关闭并 flush/fsync，再在同一文件系统内 {@code ATOMIC_MOVE} 发布为最终文件名。
         *
         * <p>不覆盖任何既有文件：每次保存都是新文件名，旧文件在提交后另行删除。
         * 发布后仍保持「在途」登记，直到事务结果确定（{@link #complete()} / {@link #rollback()}）。</p>
         */
        void publish();

        /** 事务已提交：自动删除旧文件由调用方负责，这里只解除在途登记。 */
        void complete();

        /**
         * 事务回滚：解除在途登记，并删除本次写入的文件（已发布删最终文件，未发布删临时文件）。
         *
         * <p>删除失败只记录、不抛出 —— 回滚已经发生，垃圾文件留给后续清理，不能掩盖原始失败。</p>
         */
        void rollback();

        /** 只关闭底层流（幂等）；不改变在途登记，也不删除文件。 */
        @Override
        void close();
    }
}
