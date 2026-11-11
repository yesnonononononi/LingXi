package com.summit.dp.shared.vo.block;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * 一轮里单个文件的净改动（「本轮改动」清单的一行）。
 *
 * <p><b>只带展示需要的数字与定位，不带差异正文</b>：差异全文会击穿单帧预算
 * （见 {@code FileEditRecordController} 的说明），点开预览时按
 * {@code /a/file-edits/{executionId}/{recordId}} 现取。因此这里用
 * {@code diffAvailable} 表达「能不能点开」，而不是塞一份 diff 进来再让前端看它是否为 null。</p>
 *
 * <p><b>随 {@link TurnViewVO} 下发</b>：改动清单是本轮展示视图的一部分。曾经由卡片组件
 * 挂载后单独请求汇总，于是会话加载后卡片迟到、列表高度二次增长，视图被强行顶走一段。
 * 数据随视图同帧到达，就没有这一次高度突变。</p>
 *
 * @param filePath      文件绝对路径（与文件预览入参同形）
 * @param plusLines     净新增行数
 * @param minusLines    净删除行数
 * @param edits         本轮编辑次数（前端用它提示「合并了 N 次编辑」）
 * @param created       该文件是否由本轮新建
 * @param executionId   执行标识，打开差异视图要用
 * @param recordId      末条记录标识，打开差异视图要用
 * @param diffAvailable 差异能否点开；<b>该文件本轮有可重放的记录就为 true</b>（不限最新轮次），
 *                      差异正文仍按需现取
 */
public record TurnFileChangeVO(
        @JsonProperty("filePath") String filePath,
        @JsonProperty("plusLines") int plusLines,
        @JsonProperty("minusLines") int minusLines,
        @JsonProperty("edits") int edits,
        @JsonProperty("created") boolean created,
        @JsonProperty("executionId") String executionId,
        @JsonProperty("recordId") String recordId,
        @JsonProperty("diffAvailable") boolean diffAvailable
) {
}
