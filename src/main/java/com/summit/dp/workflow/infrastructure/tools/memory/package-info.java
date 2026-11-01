/**
 * 项目 wiki 与全局长期记忆、每日工作记忆分开存放，按需读取。
 *
 * <p>目录一律以 {@code {"total":n,"returned":m,"wikis":[...]}} 形式披露，
 * {@code total} 大于 {@code returned} 即表示条目被 {@link MemoryWikiLimits} 裁剪，调用方据此改用检索工具。
 * 查询类工具的参数容错与框架 {@code list_mcp_tools}/{@code search_tool} 对齐：畸形参数只降级为「列目录/列全部」，
 * 安全边界（工作空间绑定、空名称、目录越界）仍然拒绝。</p>
 */
package com.summit.dp.workflow.infrastructure.tools.memory;
