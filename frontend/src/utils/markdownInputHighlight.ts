/**
 * 输入框实时 Markdown 语法高亮转换器。
 *
 * 核心约束：
 * 1. 绝对不能丢失或改变任何用户输入的字符（包括空格、换行、反引号等），
 *    必须保持 1:1 的字符对齐，确保双层输入框的 Caret 光标精准无错位。
 * 2. 避免引入破坏水平排版的横向 margin/padding，通过背景色与色彩差异形成高亮。
 * 3. 严格完成 HTML 实体转义，杜绝 XSS 风险。
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function highlightMarkdownInput(text: string): string {
  if (!text) return '';

  let escaped = escapeHtml(text);

  // 使用占位符保护高优先级的不可嵌套结构（代码块、行内代码、链接）
  const tokens: string[] = [];
  const pushToken = (html: string): string => {
    const id = tokens.length;
    tokens.push(html);
    return `\x00__MK_TOKEN_${id}__\x01`;
  };

  // 1. 多行代码块 (```...```)
  escaped = escaped.replace(/(```[\s\S]*?```)/g, (_match, codeBlock) => {
    return pushToken(
      `<span class="bg-zinc-800/80 text-emerald-400 dark:text-emerald-300 font-mono rounded-xs">${codeBlock}</span>`
    );
  });

  // 2. 行内代码 (`...`)
  escaped = escaped.replace(/(`[^`\n]+`)/g, (_match, inlineCode) => {
    return pushToken(
      `<span class="bg-indigo-500/15 dark:bg-white/10 text-emerald-600 dark:text-emerald-400 font-mono rounded-xs">${inlineCode}</span>`
    );
  });

  // 3. 链接 ([text](url))
  escaped = escaped.replace(/(\[[^\]\n]+\])(\([^)\n]+\))/g, (_match, label, url) => {
    return pushToken(
      `<span class="text-blue-500 dark:text-blue-400 underline">${label}</span><span class="text-blue-400/60 dark:text-blue-300/60">${url}</span>`
    );
  });

  // 4. 标题 (# ~ ###### 开头)
  escaped = escaped.replace(/^(\s*#{1,6}\s+[^\n]+)/gm, '<span class="font-bold text-sky-500 dark:text-sky-400">$1</span>');

  // 5. 引用块 (> 开头，注意前面已经转义为 &gt;)
  escaped = escaped.replace(/^(\s*&gt;\s+[^\n]+)/gm, '<span class="italic text-zinc-500 dark:text-zinc-400">$1</span>');

  // 6. 列表标记 (-, *, +, 1. 等)
  escaped = escaped.replace(/^(\s*(?:[-*+]|\d+\.)\s+)/gm, '<span class="text-amber-500 dark:text-amber-400 font-semibold">$1</span>');

  // 7. 粗体 (**...** 或 __...__)
  escaped = escaped.replace(/(\*\*[^*\n]+\*\*|__[^_\n]+__)/g, '<strong class="font-bold text-zinc-900 dark:text-white">$1</strong>');

  // 8. 斜体 (*...* 或 _..._)
  escaped = escaped.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])|(?<![_\w])_([^_\n]+)_(?![_\w])/g, (_match, p1, p2) => {
    const inner = p1 || p2;
    const delimiter = p1 ? '*' : '_';
    return `<em class="italic text-zinc-700 dark:text-zinc-200">${delimiter}${inner}${delimiter}</em>`;
  });

  // 9. 删除线 (~~...~~)
  escaped = escaped.replace(/(~~[^~\n]+~~)/g, '<span class="line-through opacity-70">$1</span>');

  // 还原受保护的 tokens
  escaped = escaped.replace(/\x00__MK_TOKEN_(\d+)__\x01/g, (_m, id) => {
    return tokens[Number(id)] ?? '';
  });

  // 尾部换行处理：HTML pre-wrap 下末尾 \n 需补充 <br> 保证高度与 textarea 完全一致
  if (text.endsWith('\n')) {
    escaped += '<br>';
  }

  return escaped;
}
