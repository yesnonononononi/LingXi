package com.summit.dp.workflow.api.request;

import java.util.List;

/**
 * 回滚入参：只带用户确认过的绝对路径。
 *
 * <p>路径必须来自预览结果 —— 后端只会执行「计划里允许 + 用户确认」的交集，
 * 传计划外的路径等于没传。</p>
 *
 * @param confirmedPaths 用户在预览弹窗里勾选的绝对路径
 */
public record RollbackFilesRequest(List<String> confirmedPaths) {
}
