// What every dashboard page writes HTML with.

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Whether a link is web or relative: links come from stage outputs, so a `javascript:` or `data:` one is text only. */
const safe = (url: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(url, 'http://localhost/').protocol);
  } catch {
    return false;
  }
};
export const link = (url: string | null | undefined, text: string, cls = '') =>
  url && safe(url) ? `<a href="${esc(url)}"${cls ? ` class="${cls}"` : ''}>${esc(text)}</a>` : esc(text);
export const prLink = (url: string | null | undefined) => (url ? link(url, `#${url.split('/').pop()}`) : '');
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
/** A time the page's script keeps current: `3 min ago`, with the moment on hover. */
export const when = (iso: string) => `<time datetime="${esc(iso)}" data-ago title="${esc(iso)}">${esc(iso)}</time>`;
/** A moment in the viewer's local time, filled in by the page's script. */
export const at = (iso: string, style: 'time' | 'date' | 'datetime' = 'datetime') =>
  `<time datetime="${esc(iso)}" data-at="${style}">${esc(iso.slice(0, 16).replace('T', ' '))}</time>`;
/** Inline code from a finding's text: backticks become code, everything else is escaped. */
export const md = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

/** Keeps `data-ago` and `data-at` times current in the viewer's zone. */
export const TIMES = `
const ago = (iso) => { const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
const fmt = { time: { hour: '2-digit', minute: '2-digit' }, date: { day: 'numeric', month: 'short' }, datetime: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, day: { weekday: 'short', day: 'numeric', month: 'short' } };
for (const t of document.querySelectorAll('time[data-at]')) t.textContent = new Date(t.dateTime).toLocaleString('en-GB', fmt[t.dataset.at]);
const times = () => { for (const t of document.querySelectorAll('time[data-ago]')) t.textContent = ago(t.dateTime); };
times(); setInterval(times, 15000);
`;

const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t: string, u: string) => `<a href="${u}">${t}</a>`);

/**
 * A reviewer's comment as GitHub shows it, for the kinds of Markdown review bots and people write: headings, bold and
 * italics, inline and fenced code, lists and task boxes, links, quotes and `<details>`. HTML comments are dropped; every
 * other piece of HTML is shown as text.
 */
export const gfm = (text: string) => {
  const lines = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r/g, '')
    .split('\n');
  const out: string[] = [];
  let list: string | null = null;
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const fence = l.match(/^\s*```/);
    if (fence) {
      close();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!);
      out.push(`<pre class="payload">${esc(code.join('\n'))}</pre>`);
      continue;
    }
    const tag = l.trim().match(/^<\/?(details|summary)>(.*?)(<\/summary>)?$/i);
    if (tag) {
      close();
      out.push(
        l
          .trim()
          .replace(/^<(\/?)(details|summary)>/i, '<$1$2>')
          .replace(/<\/summary>$/i, '</summary>')
          .replace(/<summary>(.*?)<\/summary>/i, (_, t: string) => `<summary>${inline(t)}</summary>`),
      );
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    const item = l.match(/^\s*([-*]|\d+\.)\s+(\[[ xX]\]\s+)?(.*)$/);
    if (h) {
      close();
      out.push(`<div class="md-h">${inline(h[2]!)}</div>`);
    } else if (item) {
      const kind = /\d/.test(item[1]!) ? 'ol' : 'ul';
      if (list !== kind) {
        close();
        out.push(`<${kind}>`);
        list = kind;
      }
      const box = item[2] ? `<input type="checkbox" disabled ${/x/i.test(item[2]) ? 'checked' : ''}> ` : '';
      out.push(`<li>${box}${inline(item[3]!)}</li>`);
    } else if (/^\s*>/.test(l)) {
      close();
      out.push(`<blockquote>${inline(l.replace(/^\s*>\s?/, ''))}</blockquote>`);
    } else if (/^\s*(---|\*\*\*)\s*$/.test(l)) {
      close();
      out.push('<hr>');
    } else if (!l.trim()) {
      close();
    } else {
      close();
      out.push(`<p>${inline(l)}</p>`);
    }
  }
  close();
  return `<div class="md">${out.join('')}</div>`;
};
