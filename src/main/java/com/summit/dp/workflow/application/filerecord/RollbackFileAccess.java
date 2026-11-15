package com.summit.dp.workflow.application.filerecord;

import java.util.Optional;

/**
 * 回滚要碰的那几个磁盘动作。
 *
 * <p>抽成端口只为两件事：门禁判定能在内存里被逐条验证（不碰真文件），以及写盘动作集中在一处 ——
 * 回滚是本模块唯一的写文件路径，散开就没人能一眼确认它到底往哪写。</p>
 */
public interface RollbackFileAccess {

    /** 文件是否存在；目录、符号链接一律按「不存在」处理，回滚只认常规文件。 */
    boolean exists(String absolutePath);

    /** 读当前内容；文件不存在或读失败时为空（由调用方决定是拒绝还是跳过）。 */
    Optional<String> read(String absolutePath);

    /** 整文件写入（UTF-8，不加换行、不做归一）。 */
    void write(String absolutePath, String content);

    /** 删除文件；文件本就不存在视为成功。 */
    void delete(String absolutePath);
}
