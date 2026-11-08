package com.summit.dp.shared.vo;

import java.util.List;

/** 普通工具仅提供逐项计数，不增加框架没有的组汇总。 */
public record TokenAuditOrdinaryToolsVO(List<TokenAuditToolItemVO> items) {
}
