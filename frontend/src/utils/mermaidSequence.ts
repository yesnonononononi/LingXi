// 时序图词法器不区分大小写，参与者 ID 不能直接复用这些语法关键字。
const reservedIds = new Set([
  'actor', 'participant', 'create', 'destroy', 'as', 'box', 'loop', 'rect', 'opt',
  'alt', 'else', 'par', 'par_over', 'and', 'critical', 'option', 'break', 'end',
  'over', 'note', 'activate', 'deactivate', 'sequenceDiagram', 'autonumber', 'off',
].map(word => word.toLowerCase()));

const declaration = /^(\s*(?:(?:create)\s+)?(?:participant|actor)\s+)([A-Za-z_]\w*)(\s+as\s+[^\r\n]+|\s*)$/i;
const message = /^(\s*)([^\s:]+?)(\s*(?:<<--?>>|--?>>?|--?[x)]|(?:--?\|[\\/]|--?[\\/]{2}|[\\/]\|--?|[\\/]{2}--?))\s*[+-]?)([^\s:]+)(\s*:[^\r\n]*)$/;

export function normalizeSequenceParticipants(source: string): string {
  const header = /^(?:\s*---\r?\n[\s\S]*?\r?\n---\r?\n)?(?:\s*%%[^\r\n]*\r?\n)*\s*sequenceDiagram\b[^\r\n]*\r?\n/i.exec(source);
  if (!header) return source;

  const lines = source.slice(header[0].length).split('\n');
  const descriptions = new Set<number>();
  let inDescription = false;
  lines.forEach((line, index) => {
    if (/^\s*accDescr\s*\{/i.test(line)) inDescription = true;
    if (!inDescription) return;
    descriptions.add(index);
    if (line.includes('}')) inDescription = false;
  });
  const replacements = new Map<string, string>();
  for (const [index, line] of lines.entries()) {
    if (descriptions.has(index)) continue;
    const match = declaration.exec(line.replace(/\r$/, ''));
    const id = match?.[2];
    if (!id || !reservedIds.has(id.toLowerCase()) || replacements.has(id)) continue;
    let candidate = `lxParticipant${replacements.size}`;
    // 现有源码里的 ID 必须保留身份，不能和修正后的参与者合并。
    while (source.includes(candidate)) candidate += '_';
    replacements.set(id, candidate);
  }
  if (!replacements.size) return source;

  const replaceId = (id: string): string => {
    const trimmed = id.trim();
    return id.replace(trimmed, replacements.get(trimmed) ?? trimmed);
  };
  const normalized = lines.map((line, index) => {
    if (descriptions.has(index)) return line;
    const ending = line.endsWith('\r') ? '\r' : '';
    const text = ending ? line.slice(0, -1) : line;
    if (/^\s*(?:%%|#)/.test(text)) return line;
    const declared = declaration.exec(text);
    if (declared) {
      const [, prefix, id, alias] = declared;
      const replacement = replacements.get(id!);
      if (!replacement) return line;
      // 没有别名时补回原 ID，内部重命名不能改变图中显示的文字。
      return `${prefix}${replacement}${alias!.trim() ? alias : ` as ${id}${alias}`}${ending}`;
    }
    const sent = message.exec(text);
    if (sent) {
      const [, indent, from, arrow, to, label] = sent;
      return `${indent}${replaceId(from!)}${arrow}${replaceId(to!)}${label}${ending}`;
    }
    const note = /^(\s*note\s+(?:over|left of|right of)\s+)([^:]+)(:[^\r\n]*)$/i.exec(text);
    if (note) return `${note[1]}${note[2]!.split(',').map(replaceId).join(',')}${note[3]}${ending}`;
    const action = /^(\s*(?:activate|deactivate|destroy)\s+)(\S+)(\s*)$/i.exec(text);
    if (action) return `${action[1]}${replaceId(action[2]!)}${action[3]}${ending}`;
    const metadata = /^(\s*(?:links?|properties|details)\s+)(\S+)(\s*:[^\r\n]*)$/i.exec(text);
    if (metadata) return `${metadata[1]}${replaceId(metadata[2]!)}${metadata[3]}${ending}`;
    return line;
  });
  return header[0] + normalized.join('\n');
}
