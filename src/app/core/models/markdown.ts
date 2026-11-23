// Minimal, safe Markdown → HTML for chat replies and AI notes.
// Everything is HTML-escaped first; only a small whitelist of constructs is re-introduced.
// Links get no href navigation in the webview: the component opens them via TauriBridge.openExternal.

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

function inline(text: string): string {
  // Code spans and links are set aside first, so emphasis never reaches inside them (e.g. a `*` in a URL)
  // and a URL inside a link label is not linked a second time.
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  const restore = (s: string): string => s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => restore(held[+i]));
  return restore(
    emphasis(
      text
        .replace(/\u0000/g, '')
        .replace(/`([^`\n]+)`/g, (_m, code: string) => hold(`<code>${code}</code>`))
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => hold(link(url, emphasis(label))))
        .replace(/(^|[\s(]|&quot;|&#39;)(https?:\/\/[^\s<)]+)/g, (_m, pre: string, raw: string) => {
          const { url, rest } = trimUrl(raw);
          return url.length > 'https://'.length ? pre + hold(link(url, url)) + rest : pre + raw;
        }),
    ),
  );
}

function emphasis(s: string): string {
  return s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
}

/** A bare URL ends before an (escaped) quote and before trailing sentence punctuation. */
function trimUrl(raw: string): { url: string; rest: string } {
  const quote = raw.search(/&quot;|&#39;/);
  let url = quote >= 0 ? raw.slice(0, quote) : raw;
  url = url.replace(/[.,;:!?]+$/, '');
  return { url, rest: raw.slice(url.length) };
}

function link(url: string, label: string): string {
  // `url` is already escaped (it came from escaped text), so it is safe inside the attribute.
  return `<a href="${url}" data-external="1" title="${url}">${label}</a>`;
}

export function renderMarkdown(src: string): string {
  const out: string[] = [];
  const lines = escape(src.replace(/\r\n?/g, '\n')).split('\n');
  let inCode = false;
  let code: string[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        out.push(`<pre><code>${code.join('\n')}</code></pre>`);
        code = [];
      } else flushList();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      list.push(item[1]);
      continue;
    }
    flushList();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) out.push(`<p class="md-h">${inline(heading[2])}</p>`);
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) out.push('<hr>');
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
  flushList();
  return out.join('');
}
