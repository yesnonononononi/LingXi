package com.summit.dp.execution.application.port;

import java.io.OutputStream;
import java.util.List;
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

    /**
     * 该文件是否仍在写入中（供清理跳过未完成的写入）。
     */
    boolean isInFlight(String executionId, String fileId);

    /** 当前在途写入的文件标识快照；清理逻辑按它跳过。 */
    Set<String> inFlightFileIds(String executionId);

    /**
     * 按批枚举检查点根目录下的执行目录名，供清理分批扫描使用。
     *
     * <p><b>只读目录项，不读文件正文，不递归进子目录以外的地方</b>；实现必须拒绝跟随符号链接，
     * 确保枚举范围被钉死在 {@code <数据目录>/checkpoints} 之内。</p>
     *
     * @param afterExecutionId 上一批最后一个执行标识；{@code null} 表示从头开始
     * @param limit            单批上限（实现负责夹到合理范围）
     * @return 按数字升序排列的执行标识；没有更多时返回空列表
     */
    List<String> listExecutionIds(String afterExecutionId, int limit);

    /**
     * 按批枚举某个执行目录下的文件（只读文件名，不读正文）。
     *
     * @param executionId 执行标识
     * @param limit       单批上限
     */
    List<CheckpointFile> listFiles(String executionId, int limit);

    /**
     * 删除 {@link #listFiles(String, int)} 枚举出来的那个条目。
     *
     * <p>按枚举时的精确文件名删除（未完成的临时文件也在其中），并再次校验路径仍在执行目录内；
     * 在途写入返回 {@code false} 且不删。删除失败只记录不抛出。</p>
     */
    boolean deleteFile(CheckpointFile file);

    /**
     * 把整个检查点目录复制到新的数据目录（数据目录迁移用）。
     *
     * <p><b>迁移窗口内排除检查点写入</b>：复制期间拒绝新的写入与删除（拿不到静默窗口就明确失败），
     * 这样新目录里的正文与库快照一致。只复制已发布的 {@code .json}，未完成的临时文件不复制
     * ——它们本来就属于尚未提交的事务，重启后会由清理回收。</p>
     *
     * @param targetDataDir 目标数据目录；检查点会落在其下的 {@code checkpoints/}
     * @throws IllegalStateException 还有检查点写入在进行（等不到静默窗口）
     */
    CopyResult copyTo(String targetDataDir);

    /** 库与检查点正文属于同一备份集合，必须在排除检查点写入的窗口里复制。 */
    void withWriteQuiesced(Runnable migrationStep);

    /**
     * 回收一个执行目录：**只有目录已经空了才删**。
     *
     * <p>为什么必须有这一步：正文删完以后执行目录会留下，每跑一轮执行就多一个空目录，
     * {@code checkpoints/} 下会堆到几千个 —— 清理时枚举预算全被这些空目录吃掉，真正的垃圾反而轮不到。</p>
     *
     * <p>安全边界：只接受数字执行标识，路径固定为 {@code <数据目录>/checkpoints/<executionId>}，
     * 与数据目录里的 {@code images/}、{@code skill/}、配置文件毫无交集；目录非空时
     * （{@code DirectoryNotEmptyException}）返回 {@code false} 且不做任何删除，
     * 因此「删空目录」永远不会退化成「删有正文的目录」。</p>
     *
     * <p>调用方必须持有该 {@code executionId} 的读取/写入门闩：目录删除与
     * {@link #begin(String)} 建目录必须互斥，否则会与正在发布的写入抢同一个目录。</p>
     *
     * @param executionId 执行标识（数字串）
     * @return 是否真的删掉了一个空目录
     */
    boolean deleteExecutionDirectoryIfEmpty(String executionId);

    /**
     * 连文件一起回收整个执行目录：**只允许在 {@code execution} 行已提交删除之后调用**。
     *
     * <p>与 {@link #deleteExecutionDirectoryIfEmpty(String)} 的分工：那个是「顺手带走空壳」，
     * 这个是「这个执行已经不存在了」。行都删了，目录里的文件不可能再被读到，因此不再逐个比对引用；
     * 但仍守住两条底线：<b>有在途写入就整体跳过</b>（还有线程会往里写），
     * <b>只删本实现的产物</b>（{@code .json} / {@code .part}），不递归、不跟随符号链接。</p>
     *
     * <p>删除失败只记录不抛出：会话行早已提交删除，目录残留由孤儿清扫下一轮带走。</p>
     *
     * @param executionId 执行标识（数字串）
     * @return 是否删掉了目录
     */
    boolean deleteExecutionDirectory(String executionId);

    /**
     * 文件侧是否还有可能需要回收的内容（**便宜的探测**：只列 {@code checkpoints/} 根，不读正文）。
     *
     * <p>用来把「没有可回收的数据库行」与「没有要扫描的文件」两件事分开：前者为 0 不代表
     * 文件侧干净 —— 孤儿 JSON、{@code .part} 残留、以及上一轮目录预算之后还没扫到的文件，
     * 都只能靠再扫一次回收。界面据这个标志决定是否还允许触发清理。</p>
     *
     * <p>判定刻意保守且廉价：根下存在任何执行目录，或存在 {@code .part} 临时文件，就认为
     * 「可能有要回收的文件」。允许偶尔多扫一轮，不允许把「没得清理」误报成「不用清理」。</p>
     *
     * @return 是否还有可能要扫描的文件
     */
    boolean hasUnscannedFiles();

    /** 枚举出来的检查点条目：执行标识、文件标识、精确文件名、是否未完成的临时文件。 */
    record CheckpointFile(String executionId, String fileId, String fileName, boolean temporary) { }

    /** 目录复制结果：已发布的正文数量与被跳过的未完成临时文件数量。 */
    record CopyResult(int copiedFiles, int skippedTemporaryFiles) { }

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
