package com.summit.dp.execution.application.port;

/**
 * 检查点正文文件的维护端口：删除「已不再被引用」的正文文件。
 *
 * <p><b>为什么单独一个端口</b>：删除正文文件必须与「按 executionId 互斥的读取」在同一把门闩内，
 * 而门闩在执行运行期实现（本机文件仓储那一侧）。清理入口只声明「该删哪些文件」，
 * 互斥与在途跳过由实现负责 —— 否则清理会把「已查到引用、尚未打开文件」的读取踩断。</p>
 */
public interface ExecutionCheckpointMaintenance {

    /**
     * 删除某个执行已不再被引用的正文文件（数据库删除提交之后调用）。
     *
     * <p>与读取互斥；在途写入不删；文件标识为空或非法直接返回 {@code false}。</p>
     *
     * @param executionId 执行标识（数字串）
     * @param fileId      被替换/被删除的那份正文的文件标识；{@code null} 表示没有文件要删
     * @return 是否确实删除了文件
     */
    boolean deleteFile(String executionId, String fileId);

    /**
     * 按批回收 {@code <数据目录>/checkpoints} 下所有无引用的文件。
     *
     * <p>覆盖三类垃圾：提交后删除失败留下的旧文件、数据库行已消失的孤儿文件、
     * 以及未完成的临时文件（{@code .part}）。只扫 checkpoints 根目录内的执行子目录，
     * 不读正文、不碰数据目录里的其它内容（images / skill / 配置等）。</p>
     *
     * @param maxExecutionDirectories 本轮最多扫描多少个执行目录（分批，避免长扫描）
     * @param maxFilesPerExecution    单个执行目录每轮最多处理多少个文件
     * @return 实际删除的文件数与被跳过的在途文件数
     */
    FileReclaimResult reclaimUnreferenced(int maxExecutionDirectories, int maxFilesPerExecution);

    /** 文件回收结果：删了几个、因为仍在写入而跳过了几个。 */
    record FileReclaimResult(int deletedFiles, int skippedInFlight) { }
}
