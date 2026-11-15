/**
 * 判断文件是否为 Markdown（按文件名或路径后缀识别，大小写不敏感）。
 */
export function isMarkdownFile(nameOrPath: string | null | undefined): boolean {
  if (!nameOrPath) return false;
  return /\.(?:md|markdown)$/i.test(nameOrPath.trim());
}
