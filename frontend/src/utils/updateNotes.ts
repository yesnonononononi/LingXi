import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

const markdown = new MarkdownIt({ html: true, breaks: true, linkify: true });

/** Release 同时可能带 Markdown 和 HTML；只允许正文排版，禁止执行远端内容。 */
export function renderUpdateNotes(notes: string): string {
  if (!notes) return '';
  const html = DOMPurify.sanitize(markdown.render(notes), {
    ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 's', 'a', 'pre', 'code', 'blockquote', 'hr'],
    ALLOWED_ATTR: ['href', 'title'],
  });
  const document = new DOMParser().parseFromString(html, 'text/html');
  if (!document.body.textContent?.trim()) return '';
  for (const link of document.querySelectorAll('a')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  return document.body.innerHTML;
}
