import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('escapes HTML before formatting', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **bold**');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('renders code, lists, headings and links', () => {
    const html = renderMarkdown('# Title\n- one `a<b`\n- two\n\nSee [crt.sh](https://crt.sh/?q=x) or https://example.com/path.\n```\nraw *x*\n```');
    expect(html).toContain('<p class="md-h">Title</p>');
    expect(html).toContain('<ul><li>one <code>a&lt;b</code></li><li>two</li></ul>');
    expect(html).toContain('<a href="https://crt.sh/?q=x" data-external="1"');
    expect(html).toContain('<a href="https://example.com/path" data-external="1"');
    expect(html).toContain('<pre><code>raw *x*</code></pre>');
  });

  it('keeps emphasis out of URLs and never nests links', () => {
    const star = renderMarkdown('see https://example.com/*foo*/bar and *this*');
    expect(star).toContain('<a href="https://example.com/*foo*/bar" data-external="1"');
    expect(star).toContain('<em>this</em>');
    expect(star).not.toContain('<em>foo</em>');

    const labelled = renderMarkdown('[see https://a.example **now**](https://b.example/x)');
    expect(labelled.match(/<a /g)?.length).toBe(1);
    expect(labelled).toContain('>see https://a.example <strong>now</strong></a>');
  });

  it('links quoted URLs without swallowing the quote', () => {
    const html = renderMarkdown('url="https://example.com/a" and \'https://example.org\'.');
    expect(html).toContain('<a href="https://example.com/a" data-external="1"');
    expect(html).toContain('</a>&quot; and');
    expect(html).toContain('<a href="https://example.org" data-external="1"');
    expect(html).not.toContain('&quot"');
  });

  it('does not turn javascript: links into anchors', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a');
  });
});
