import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import { t } from '../i18n';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
  highlight: (str: string, lang: string): string => {
    let highlighted = '';
    const validLang = lang && hljs.getLanguage(lang) ? lang : '';
    try {
      if (validLang) {
        highlighted = hljs.highlight(str, { language: validLang, ignoreIllegals: true }).value;
      } else {
        highlighted = hljs.highlightAuto(str).value;
      }
    } catch {
      highlighted = md.utils.escapeHtml(str);
    }

    const displayLang = validLang || lang || 'code';
    const encoded = encodeURIComponent(str);

    return `<div class="content-block code-block">` +
      `<div class="block-toolbar block-toolbar--code">` +
        `<span class="lang-badge">${md.utils.escapeHtml(displayLang)}</span>` +
        `<button type="button" class="copy-code-btn" data-code="${encoded}" title="${md.utils.escapeHtml(t('markdown.copyCode'))}">` +
          `<svg class="copy-icon w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">` +
            `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />` +
          `</svg>` +
          `<span class="copy-text">${md.utils.escapeHtml(t('markdown.copy'))}</span>` +
        `</button>` +
      `</div>` +
      `<pre><code class="hljs ${md.utils.escapeHtml(validLang)}">${highlighted}</code></pre>` +
    `</div>`;
  }
});

export interface MermaidDiagram {
  source: string;
  complete: boolean;
}

export interface MarkdownDocument {
  html: string;
  diagrams: MermaidDiagram[];
}

interface DiagramEnvironment {
  [key: PropertyKey]: unknown;
  diagrams: MermaidDiagram[];
  lines: string[];
  streaming: boolean;
}

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, index, options, environment, renderer) => {
  const env = environment as DiagramEnvironment | undefined;
  const token = tokens[index]!;
  if (!env?.diagrams || token.info.trim().split(/\s+/)[0]?.toLowerCase() !== 'mermaid') {
    return defaultFence(tokens, index, options, env, renderer);
  }

  // Markdown 允许围栏在正文末尾隐式结束，但流式末尾仍可能继续收到图表源码。
  const lastLine = env.lines[(token.map?.[1] ?? 0) - 1] ?? '';
  const closing = lastLine.trim().replace(/^(?:>\s*)+/, '').trim();
  const closed = closing.length >= token.markup.length && [...closing].every(char => char === token.markup[0]);
  const diagramIndex = env.diagrams.push({ source: token.content, complete: closed || !env.streaming }) - 1;
  return `<div data-mermaid-index="${diagramIndex}"></div>\n`;
};

// Configure external links to open in a new tab safely
const defaultLinkOpen = md.renderer.rules.link_open || function (tokens: any[], idx: number, options: any, _env: any, self: any) {
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.link_open = function (tokens: any[], idx: number, options: any, env: any, self: any) {
  const aIndex = tokens[idx].attrIndex('target');
  if (aIndex < 0) {
    tokens[idx].attrPush(['target', '_blank']);
  } else {
    tokens[idx].attrs![aIndex][1] = '_blank';
  }
  const relIndex = tokens[idx].attrIndex('rel');
  if (relIndex < 0) {
    tokens[idx].attrPush(['rel', 'noopener noreferrer']);
  } else {
    tokens[idx].attrs![relIndex][1] = 'noopener noreferrer';
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(content: string): string {
  if (!content) return '';
  const rawHtml = md.render(content);
  return DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['target', 'rel', 'data-code'],
    ADD_TAGS: ['button', 'svg', 'path', 'span']
  });
}

export function renderMarkdownDocument(content: string, streaming: boolean): MarkdownDocument {
  const env: DiagramEnvironment = { diagrams: [], lines: content.replace(/\r\n?/g, '\n').split('\n'), streaming };
  const html = DOMPurify.sanitize(md.render(content, env), {
    ADD_ATTR: ['target', 'rel', 'data-code', 'data-mermaid-index'],
    ADD_TAGS: ['button', 'svg', 'path', 'span'],
  });
  return { html, diagrams: env.diagrams };
}
