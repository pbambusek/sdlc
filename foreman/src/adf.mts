// Atlassian Document Format to Markdown, for the parts a spec and a tick comment use.

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

const inline = (nodes: AdfNode[] = []): string => nodes.map(inlineNode).join('');

const inlineNode = (n: AdfNode): string => {
  switch (n.type) {
    case 'text': {
      let t = n.text ?? '';
      for (const m of n.marks ?? []) {
        if (m.type === 'code') t = `\`${t}\``;
        else if (m.type === 'strong') t = `**${t}**`;
        else if (m.type === 'em') t = `*${t}*`;
        else if (m.type === 'strike') t = `~~${t}~~`;
        else if (m.type === 'link') t = `[${t}](${String(m.attrs?.href ?? '')})`;
      }
      return t;
    }
    case 'hardBreak':
      return '\n';
    case 'mention':
      return String(n.attrs?.text ?? '@someone');
    case 'emoji':
      return String(n.attrs?.text ?? n.attrs?.shortName ?? '');
    case 'inlineCard':
      return String(n.attrs?.url ?? '');
    case 'status':
      return `[${String(n.attrs?.text ?? '')}]`;
    case 'date':
      return new Date(Number(n.attrs?.timestamp ?? 0)).toISOString().slice(0, 10);
    default:
      return inline(n.content);
  }
};

const indent = (s: string, by: string) =>
  s
    .split('\n')
    .map((l, i) => (i === 0 || !l ? l : by + l))
    .join('\n');

const block = (n: AdfNode): string => {
  switch (n.type) {
    case 'paragraph':
      return inline(n.content);
    case 'heading':
      return `${'#'.repeat(Number(n.attrs?.level ?? 2))} ${inline(n.content)}`;
    case 'bulletList':
      return (n.content ?? []).map((li) => `- ${indent(blocks(li.content), '  ')}`).join('\n');
    case 'orderedList': {
      const start = Number(n.attrs?.order ?? 1);
      return (n.content ?? []).map((li, i) => `${start + i}. ${indent(blocks(li.content), '   ')}`).join('\n');
    }
    case 'taskList':
      return (n.content ?? []).map((t) => `- [${t.attrs?.state === 'DONE' ? 'x' : ' '}] ${inline(t.content)}`).join('\n');
    case 'codeBlock':
      return `\`\`\`${String(n.attrs?.language ?? '')}\n${inline(n.content)}\n\`\`\``;
    case 'blockquote':
      return blocks(n.content)
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'panel':
      return blocks(n.content)
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'rule':
      return '---';
    case 'table': {
      const rows = (n.content ?? []).map((r) => (r.content ?? []).map((c) => blocks(c.content).replace(/\n/g, ' ').replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      return [line(rows[0]!), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return '[attachment]';
    case 'expand':
    case 'nestedExpand':
      return [n.attrs?.title ? `**${String(n.attrs.title)}**` : '', blocks(n.content)].filter(Boolean).join('\n\n');
    default:
      return n.content ? blocks(n.content) : inlineNode(n);
  }
};

const blocks = (nodes: AdfNode[] = []): string =>
  nodes
    .map(block)
    .filter((s) => s !== '')
    .join('\n\n');

export const adfToMarkdown = (doc: AdfNode | null | undefined): string => (doc ? blocks(doc.content).trim() : '');

/** A comment body: one paragraph per line. */
export const textToAdf = (text: string): AdfNode & { version: 1 } => ({
  type: 'doc',
  version: 1,
  content: text.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
});
