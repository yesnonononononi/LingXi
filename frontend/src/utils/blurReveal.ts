export const BLUR_REVEAL_DURATION = 290;

export interface RevealRange {
  id: number;
  start: number;
  end: number;
  started: number;
}

/** 位置基于可见文字，Markdown 换标签或重新高亮时不会把旧字当成新字。 */
export class BlurRevealState {
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
      this.ranges.push({ id: ++this.sequence, start: prefix, end: nextEnd, started: now });
    }
    this.ranges.sort((left, right) => left.start - right.start);
    this.text = text;
    this.initialized = true;
    this.expire(now);
  }

  expire(now: number): void {
    this.ranges = this.ranges.filter(range => now - range.started < BLUR_REVEAL_DURATION);
  }

  clear(): void {
    this.ranges = [];
  }
}
