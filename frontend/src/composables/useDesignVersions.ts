import {ref} from 'vue';
import {createLocalId} from '../utils/ids';

export type DesignVersionSource = 'initial' | 'manual' | 'ai' | 'restore';

export interface DesignVersionEntry {
  id: string;
  createdAt: number;
  source: DesignVersionSource;
  label: string;
  html: string;
  lineCount: number;
  charCount: number;
}

export interface DesignVersionDiffLine {
  kind: 'ctx' | 'add' | 'del';
  text: string;
}

export interface DesignVersionDiff {
  added: number;
  removed: number;
  lines: DesignVersionDiffLine[];
  truncated: boolean;
}

const MAX_VERSIONS = 30;
const MAX_DIFF_LINES = 120;

const SOURCE_LABELS: Record<DesignVersionSource, string> = {
  initial: '初始载入',
  manual: '手动保存',
  ai: 'AI 更新',
  restore: '版本回退',
};

/**
 * 计算两份 HTML 的轻量行级差异，供版本历史面板「对比当前」展示。
 * 使用 LCS 对齐，行数过大时截断到前 600 行，保证面板交互不卡顿。
 */
export function computeDesignVersionDiff(baseHtml: string, currentHtml: string): DesignVersionDiff {
  const a = baseHtml.replace(/\r\n?/g, '\n').split('\n');
  const b = currentHtml.replace(/\r\n?/g, '\n').split('\n');
  const truncated = a.length > 600 || b.length > 600;
  const sa = a.slice(0, 600);
  const sb = b.slice(0, 600);

  const m = sa.length;
  const n = sb.length;
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = sa[i] === sb[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const raw: DesignVersionDiffLine[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < m && j < n) {
    if (sa[i] === sb[j]) {
      raw.push({ kind: 'ctx', text: sa[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      raw.push({ kind: 'del', text: sa[i]! });
      removed++;
      i++;
    } else {
      raw.push({ kind: 'add', text: sb[j]! });
      added++;
      j++;
    }
  }
  while (i < m) {
    raw.push({ kind: 'del', text: sa[i++]! });
    removed++;
  }
  while (j < n) {
    raw.push({ kind: 'add', text: sb[j++]! });
    added++;
  }

  // 只保留改动行及其前后各 1 行上下文，避免整页 HTML 淹没重点。
  const changedIdx = new Set<number>();
  raw.forEach((line, idx) => {
    if (line.kind !== 'ctx') {
      changedIdx.add(Math.max(0, idx - 1));
      changedIdx.add(idx);
      changedIdx.add(Math.min(raw.length - 1, idx + 1));
    }
  });
  const compact = raw.filter((_, idx) => changedIdx.has(idx));
  return {
    added,
    removed,
    lines: compact.slice(0, MAX_DIFF_LINES),
    truncated: truncated || compact.length > MAX_DIFF_LINES,
  };
}

/** 管理当前设计原型的版本快照列表（支持 AI 更新、手动保存与回退）。 */
export function useDesignVersions() {
  const versions = ref<DesignVersionEntry[]>([]);

  const recordVersion = (html: string, source: DesignVersionSource, label?: string): DesignVersionEntry | null => {
    const trimmed = html.trim();
    if (!trimmed) return null;
    if (versions.value[0]?.html === trimmed) return versions.value[0]!;

    const entry: DesignVersionEntry = {
      id: createLocalId('ver'),
      createdAt: Date.now(),
      source,
      label: label || SOURCE_LABELS[source],
      html: trimmed,
      lineCount: trimmed.split('\n').length,
      charCount: trimmed.length,
    };
    versions.value.unshift(entry);
    if (versions.value.length > MAX_VERSIONS) {
      versions.value.length = MAX_VERSIONS;
    }
    return entry;
  };

  const clearVersions = (): void => {
    versions.value = [];
  };

  return { versions, recordVersion, clearVersions };
}
