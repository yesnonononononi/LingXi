export const TEXT_ARRIVAL_DURATION = 480;
export const MAX_ARRIVAL_GRAPHEMES = 96;
export const MAX_ARRIVAL_RANGES = 128;
const CHUNK_GRAPHEMES = 3;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface RevealRange {
  id: number;
  start: number;
  end: number;
  started: number;
}

/** 位置基于可见文字，Markdown 换标签或重新高亮时不会把旧字当成新字。 */
export class ProgressiveFadeState {
  private text = '';
  private initialized = false;
  private sequence = 0;
  ranges: RevealRange[] = [];

  update(text: string, enabled: boolean, now: number, revealInitial = false): void {
    let prefix = 0;
    while (prefix < this.text.length && prefix < text.length && this.text[prefix] === text[prefix]) prefix++;
    let suffix = 0;
    while (suffix < this.text.length - prefix && suffix < text.length - prefix
      && this.text[this.text.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;

    const previousEnd = this.text.length - suffix;
    const nextEnd = text.length - suffix;
    const shift = text.length - this.text.length;
    // 只保留仍在原文中的区间；结构重解析不能重置它们的起始时刻。
    this.ranges = enabled ? this.ranges.flatMap(range => {
      const retained: RevealRange[] = [];
      if (range.start < prefix) retained.push({ ...range, end: Math.min(range.end, prefix) });
      if (range.end > previousEnd) retained.push({ ...range,
        start: Math.max(range.start, previousEnd) + shift, end: range.end + shift });
      return retained;
    }) : [];
    // 改写区域直接定型；多处 Markdown 标记同时闭合时，不能把其中的旧字误判成新增。
    if (enabled && (this.initialized || revealInitial) && previousEnd === prefix && nextEnd > prefix) {
      const tail: number[] = [];
      let total = 0;
      for (const part of segmenter.segment(text.slice(prefix, nextEnd))) {
        tail[total++ % MAX_ARRIVAL_GRAPHEMES] = prefix + part.index;
      }
      const head = total > MAX_ARRIVAL_GRAPHEMES ? total % MAX_ARRIVAL_GRAPHEMES : 0;
      const starts = [...tail.slice(head), ...tail.slice(0, head)];
      const count = Math.ceil(starts.length / CHUNK_GRAPHEMES);
      // 大包不能整屏同时变浅；头部直接定型，尾部从较深到较浅，所有文字都在当前帧出现。
      const spread = Math.min(TEXT_ARRIVAL_DURATION * 0.75, (count - 1) * 16);
      for (let index = 0; index < count; index++) {
        this.ranges.push({ id: ++this.sequence, start: starts[index * CHUNK_GRAPHEMES]!,
          end: starts[(index + 1) * CHUNK_GRAPHEMES] ?? nextEnd,
          started: now - (count > 1 ? spread * (1 - index / (count - 1)) : 0) });
      }
    }
    this.ranges.sort((left, right) => left.start - right.start);
    // 极高频小包只保留最近的尾迹，不让历史小片段占满 DOM。
    this.ranges = this.ranges.slice(-MAX_ARRIVAL_RANGES);
    this.text = text;
    this.initialized = true;
    this.expire(now);
  }

  expire(now: number): void {
    this.ranges = this.ranges.filter(range => now - range.started < TEXT_ARRIVAL_DURATION);
  }

  clear(): void {
    this.ranges = [];
  }
}
