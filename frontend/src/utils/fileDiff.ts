/**
 * 统一差异 ↔ 全文的行级合并（预览面板唯一实现）。
 *
 * <p>后端只下发 unified diff（带 3 行上下文），而面板要展示「完整文件 + 本次改动嵌入」。
 * 于是分工固定：diff 的 hunk 决定哪些行是增/删，文件全文提供其余上下文行与真实行号。
 * 两侧都不可省——只靠 diff 还原不出未变更行，只靠全文无法区分改动行。</p>
 *
 * <p>行号口径：新增/上下文行给新文件行号；删除行给它在旧文件里的行号（该行在新文件中已不存在）。</p>
 */

/** 合并后的一行。 */
export interface MergedDiffLine {
  kind: 'context' | 'add' | 'del';
  /** 行号；无法确定时为 null（解析失败或行数与全文不匹配）。 */
  lineNumber: number | null;
  text: string;
}

interface DiffHunkLine {
  type: ' ' | '+' | '-';
  text: string;
}

interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffHunkLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** 解析 unified diff 的 hunk；无法识别的行（如 `\ No newline at end of file`）直接忽略。 */
export function parseUnifiedDiff(unifiedDiff: string): DiffHunk[] {
  if (!unifiedDiff) return [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const line of unifiedDiff.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('\\')) continue;
    const marker = line.charAt(0);
    if (marker === '+' || marker === '-' || marker === ' ') {
      current.lines.push({ type: marker, text: line.slice(1) });
    }
  }
  return hunks;
}

/**
 * 把 unified diff 合并进文件全文，得到可直接逐行渲染的结果。
 *
 * <p>全文与 hunk 行数不一致时（文件在编辑后又被改过）宁可让该段行号退化为 null，
 * 也不把错误的行号标给用户。</p>
 */
export function mergeFullFileDiff(fullText: string, unifiedDiff: string): MergedDiffLine[] {
  const fullLines = splitPreviewLines(fullText);
  const hunks = parseUnifiedDiff(unifiedDiff);
  const merged: MergedDiffLine[] = [];
  let cursor = 0;
  let newLineNumber = 1;

  for (const hunk of hunks) {
    const hunkStart = Math.max(hunk.oldStart - 1, 0);
    // hunk 之前的行原样保留。
    while (cursor < hunkStart && cursor < fullLines.length) {
      merged.push({ kind: 'context', lineNumber: newLineNumber, text: fullLines[cursor]! });
      cursor++;
      newLineNumber++;
    }
    let oldLineNumber = hunk.oldStart;
    let hunkNewLineNumber = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.type === '-') {
        merged.push({ kind: 'del', lineNumber: oldLineNumber, text: line.text });
        oldLineNumber++;
        continue;
      }
      // 新增与上下文行都真实存在于全文里，文本以全文为准，避免行尾差异造成重复标注。
      const text = fullLines[cursor] ?? line.text;
      merged.push({ kind: line.type === '+' ? 'add' : 'context', lineNumber: hunkNewLineNumber, text });
      cursor++;
      oldLineNumber++;
      hunkNewLineNumber++;
      newLineNumber = hunkNewLineNumber;
    }
  }

  while (cursor < fullLines.length) {
    merged.push({ kind: 'context', lineNumber: newLineNumber, text: fullLines[cursor]! });
    cursor++;
    newLineNumber++;
  }
  return merged;
}

/** 全文按行切分；末尾换行只表示文件结束，不多出一条空行。 */
function splitPreviewLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
