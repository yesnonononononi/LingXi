export const THINKING_FRAME_INTERVAL = 32;
export const THINKING_MAX_LAG = 240;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface PendingArrival {
  end: number;
  arrived: number;
}

/** 只推进展示位置，原始消息始终由调用方持有；每批到达的追赶期限不能被后续增量延后。 */
export class ThinkingTextScheduler {
  private text: string;
  private shown: number;
  private arrivals: PendingArrival[] = [];
  private committed: number;

  constructor(text = '', now = 0) {
    this.text = text;
    this.shown = text.length;
    this.committed = now;
  }

  get content(): string { return this.text.slice(0, this.shown); }
  get pending(): boolean { return this.shown < this.text.length; }

  receive(text: string, enabled: boolean, now: number): void {
    if (!enabled || !text.startsWith(this.text)) {
      this.text = text;
      this.shown = text.length;
      this.arrivals = [];
      this.committed = now;
      return;
    }
    if (text.length === this.text.length) return;
    if (!this.pending) this.committed = now;
    const last = this.arrivals.at(-1);
    // 同一显示周期内的小包共用最早期限，避免为每个 Token 长期保留队列项。
    if (last && now - last.arrived < THINKING_FRAME_INTERVAL) last.end = text.length;
    else this.arrivals.push({ end: text.length, arrived: now });
    this.text = text;
  }

  advance(now: number): boolean {
    if (!this.pending || now - this.committed < THINKING_FRAME_INTERVAL) return false;
    const remaining = THINKING_MAX_LAG - (now - this.arrivals[0]!.arrived);
    const steps = Math.max(1, Math.ceil(remaining / THINKING_FRAME_INTERVAL));
    let end = this.shown + Math.ceil((this.text.length - this.shown) / steps);
    // 主线程暂停或标签页恢复时，已到期内容必须直接追上，不能继续慢放。
    for (const arrival of this.arrivals) {
      if (now - arrival.arrived >= THINKING_MAX_LAG) end = Math.max(end, arrival.end);
    }
    const grapheme = segmenter.segment(this.text).containing(end);
    if (grapheme && grapheme.index < end) {
      end = grapheme.index > this.shown ? grapheme.index : grapheme.index + grapheme.segment.length;
    }
    this.shown = Math.min(this.text.length, end);
    this.arrivals = this.arrivals.filter(arrival => arrival.end > this.shown);
    this.committed = now;
    return true;
  }

  dispose(): void {
    this.text = '';
    this.shown = 0;
    this.arrivals = [];
  }
}
