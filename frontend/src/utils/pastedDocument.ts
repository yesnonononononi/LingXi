export interface PastedDocument {
  id: string;
  title: string;
  content: string;
  charCount: number;
  lineCount: number;
  language?: string;
}

export const LARGE_TEXT_MIN_CHARS = 500;
export const LARGE_TEXT_MIN_LINES = 15;
export const LARGE_TEXT_MIN_TOTAL_FOR_LINES = 200;

/**
 * 判断粘贴的文本是否达到「大长度文本」阈值，应当转换为文档小卡片。
 *
 * <p>阈值规则：
 * 1. 字符数 >= 500；或者
 * 2. 行数 >= 15 行且总字符数 >= 200（例如代码片段、调用栈日志、列表）。</p>
 */
export function isLargePastedText(text: string): boolean {
  if (!text) return false;
  if (text.length >= LARGE_TEXT_MIN_CHARS) return true;
  const lines = text.split(/\r\n|\r|\n/);
  return lines.length >= LARGE_TEXT_MIN_LINES && text.trim().length >= LARGE_TEXT_MIN_TOTAL_FOR_LINES;
}

/**
 * 从文本内容提取贴切的标题（如首行注释文件名、Markdown 标题或前几十个字）。
 */
export function resolvePastedDocumentTitle(text: string, fallbackTitle = '已粘贴文本'): string {
  if (!text) return fallbackTitle;
  const lines = text.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return fallbackTitle;

  const firstLine = lines[0] ?? '';
  // 识别常见文件头注释，例如 // filename.ts 或 # filename.py 或 /* filename.css */
  const commentMatch = firstLine.match(/^(?:\/\/\s*|#\s*|\/\*\s*|<!--\s*)([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)(?:\s*\*\/|\s*-->)?$/);
  if (commentMatch?.[1]) {
    return commentMatch[1];
  }

  // 识别 Markdown 标题，如 # 架构说明
  const headingMatch = firstLine.match(/^#{1,6}\s+(.+)$/);
  if (headingMatch?.[1]) {
    return headingMatch[1].slice(0, 30).trim();
  }

  // 避免将单独的括号/标点作为标题，向下搜寻一个有具体文本的行
  for (const line of lines.slice(0, 3)) {
    const cleaned = line.replace(/^[/*#\s]+/, '').trim();
    if (cleaned.length >= 3 && !/^[{}[\]();,]+$/.test(cleaned)) {
      return cleaned.slice(0, 26).trim();
    }
  }

  return fallbackTitle;
}

/**
 * 格式化文档统计信息（如 "1.2k 字符 · 32 行" 或 "450 字符 · 16 行"）。
 */
export function formatDocumentStat(doc: { charCount: number; lineCount: number }): string {
  const chars = doc.charCount >= 1000 ? `${(doc.charCount / 1000).toFixed(1)}k` : `${doc.charCount}`;
  return `${chars} 字符 · ${doc.lineCount} 行`;
}

let docCounter = 0;

/**
 * 根据粘贴的大文本创建 PastedDocument 实体。
 */
export function createPastedDocument(
  text: string,
  options?: { title?: string; fallbackTitle?: string; id?: string }
): PastedDocument {
  const lines = text.split(/\r\n|\r|\n/);
  const id = options?.id || `doc_${Date.now()}_${++docCounter}`;
  const title = options?.title || resolvePastedDocumentTitle(text, options?.fallbackTitle);
  return {
    id,
    title,
    content: text,
    charCount: text.length,
    lineCount: lines.length,
  };
}

/**
 * 将用户在输入框键入的提示词与文档卡片正文拼装为本轮发送给模型的完整 prompt。
 *
 * <p>排版规则：
 * 1. 存在用户 prompt 时置于顶部，下方以空行分隔各文档块。
 * 2. 文档使用带标题与代码栅格（若文档含 ``` 则自动升档为 ```` 避免解析截断）。
 * 3. 仅有文档而无提示词时直接返回文档代码块。</p>
 */
export function composeMessageWithDocuments(inputText: string, documents: PastedDocument[]): string {
  const trimmed = inputText.trim();
  if (documents.length === 0) return trimmed;

  const docBlocks = documents.map(doc => {
    const fence = doc.content.includes('```') ? '````' : '```';
    const header = doc.title ? `[文档: ${doc.title}]\n` : '';
    return `${header}${fence}\n${doc.content}\n${fence}`;
  }).join('\n\n');

  if (!trimmed) {
    return docBlocks;
  }
  return `${trimmed}\n\n${docBlocks}`;
}

export interface ParsedMessageDocuments {
  text: string;
  documents: PastedDocument[];
}

const DOCUMENT_BLOCK_PATTERN = /(?:^|\r?\n)\[文档: ([^\r\n]+)\]\r?\n(`{3,})\r?\n([\s\S]*?)\r?\n\2(?=\r?\n\r?\n|\r?\n?$)/g;

/**
 * 将用户消息正文按与输入框相同的口径解析为「附带文本 + 逻辑文档卡片」集合。
 *
 * <p>同时兼容两类来源：
 * 1. 由 `composeMessageWithDocuments` 拼装的 `[文档: 标题]` 代码栅格块；
 * 2. 未经封装但整体达到 `isLargePastedText` 阈值的纯大文本消息。</p>
 */
export function parseMessageDocuments(content: string): ParsedMessageDocuments {
  if (!content) {
    return { text: '', documents: [] };
  }

  const documents: PastedDocument[] = [];
  const textParts: string[] = [];
  let cursor = 0;

  DOCUMENT_BLOCK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = DOCUMENT_BLOCK_PATTERN.exec(content);
  while (match !== null) {
    const leadingText = content.slice(cursor, match.index).trim();
    if (leadingText) {
      textParts.push(leadingText);
    }
    const title = match[1] ?? '';
    const docContent = match[3] ?? '';
    documents.push(
      createPastedDocument(docContent, {
        title,
        id: `msg_doc_${documents.length}`
      })
    );
    cursor = match.index + match[0].length;
    match = DOCUMENT_BLOCK_PATTERN.exec(content);
  }

  if (documents.length === 0) {
    if (isLargePastedText(content)) {
      return {
        text: '',
        documents: [createPastedDocument(content, { id: 'msg_doc_0' })]
      };
    }
    return { text: content, documents: [] };
  }

  const trailingText = content.slice(cursor).trim();
  if (trailingText) {
    textParts.push(trailingText);
  }

  const remainingText = textParts.join('\n\n');
  if (remainingText && isLargePastedText(remainingText)) {
    return {
      text: '',
      documents: [createPastedDocument(remainingText, { id: 'msg_doc_text' }), ...documents]
    };
  }

  return {
    text: remainingText,
    documents
  };
}
