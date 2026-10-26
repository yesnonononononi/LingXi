import DOMPurify from 'dompurify';

let sequence = 0;
let queue: Promise<unknown> = Promise.resolve();

export function renderMermaid(source: string, dark: boolean): Promise<string> {
  // Mermaid 的配置是全局状态，初始化与渲染必须成对串行，避免多图串色。
  const task = queue.then(async () => {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: dark ? 'dark' : 'default',
      htmlLabels: false,
    });
    const { svg } = await mermaid.render(`lx-mermaid-${++sequence}`, source);
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  });
  // 一张图的语法错误不能阻断后面的图。
  queue = task.catch(() => undefined);
  return task;
}
