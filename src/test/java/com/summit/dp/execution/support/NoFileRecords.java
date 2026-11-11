package com.summit.dp.execution.support;

import com.summit.dp.execution.application.port.FileRecordMaintenance;

import java.time.Instant;

/**
 * 「没有文件编辑记录」的清理端口替身。
 *
 * <p>多条清理用例只关心执行行与检查点文件，与记录回收无关；有了它，这些用例不必各自
 * 实现两个方法，也不会因为端口多一个计数方法而集体编译失败。</p>
 */
public class NoFileRecords implements FileRecordMaintenance {

    @Override
    public long countBefore(Instant cutoff) {
        return 0;
    }

    @Override
    public int purgeBefore(Instant cutoff) {
        return 0;
    }
}
