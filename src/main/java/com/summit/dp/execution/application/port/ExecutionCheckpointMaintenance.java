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
     * 按批回收 {@code <数据目录>/checkpoints} 下所有无引用的文件，并顺手回收删空的执行目录。
     *
     * <p>覆盖三类垃圾：提交后删除失败留下的旧文件、数据库行已消失的孤儿文件、
     * 以及未完成的临时文件（{@code .part}）。只扫 checkpoints 根目录内的执行子目录，
     * 不读正文、不碰数据目录里的其它内容（images / skill / 配置等）。</p>
     *
     * <p><b>枚举必须能推进</b>：实现要跨调用记住扫描位置（游标），否则每轮都从最小 id
     * 重扫同一批目录 —— 一旦目录数超过单轮预算，更大 id 里的孤儿文件与临时文件永远轮不到。
     * 保证的收敛性：单轮最多扫 {@code maxExecutionDirectories} 个目录；目录总数为 N 时，
     * 连续调用最多 {@code ceil(N / maxExecutionDirectories) + 1} 轮即可覆盖全部目录。</p>
     *
     * @param maxExecutionDirectories 本轮最多扫描多少个执行目录（分批，避免长扫描）
     * @param maxFilesPerExecution    单个执行目录每轮最多处理多少个文件
     * @return 实际删除的文件数、被跳过的在途文件数与回收的空目录数
     */
    FileReclaimResult reclaimUnreferenced(int maxExecutionDirectories, int maxFilesPerExecution);

    /**
     * 文件侧是否还有可能要被扫描的内容（便宜探测：只看 {@code checkpoints/} 根，不读正文）。
     *
     * <p>预览用它把「没有可回收的数据库行」与「文件侧不用扫」分开；为 {@code true} 时界面
     * 仍要允许触发清理，因为孤儿文件、{@code .part} 残留以及上一轮目录预算之后的文件
     * 只能靠再扫一次回收。</p>
     */
    boolean hasUnscannedFiles();

    /** 文件回收结果：删了几个文件、因为仍在写入而跳过了几个、顺带删掉了几个空执行目录。 */
    record FileReclaimResult(int deletedFiles, int skippedInFlight, int deletedDirectories) {

        /** 只关心文件数的调用方可以用这个两参形式，目录数按 0 记。 */
        public FileReclaimResult(int deletedFiles, int skippedInFlight) {
            this(deletedFiles, skippedInFlight, 0);
        }
    }
}
