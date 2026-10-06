import { html, useMemo } from '../vendor/preact-htm.js';
import { parseMarkdown } from '../lib/markdown.js';

// The assistant's answer, drawn from the data the reader makes of it. Every
// piece of text goes in as a text node, so nothing in an answer can become
// markup, whatever it says.
const inline = (parts) =>
	parts.map((part) => {
		if (part.type === 'text') return part.text;
		if (part.type === 'code') return html`<code>${part.text}</code>`;
		if (part.type === 'strong') return html`<strong>${inline(part.children)}</strong>`;
		return html`<em>${inline(part.children)}</em>`;
	});

function block(item) {
	if (item.type === 'paragraph') return html`<p>${inline(item.inline)}</p>`;
	if (item.type === 'heading') return html`<p class="md__heading" role="heading" aria-level=${Math.min(6, item.level + 2)}>${inline(item.inline)}</p>`;
	if (item.type === 'code') return html`<pre class="md__code" data-language=${item.language || undefined}><code>${item.text}</code></pre>`;
	if (item.type === 'quote') return html`<blockquote>${inline(item.inline)}</blockquote>`;
	if (item.type === 'rule') return html`<hr />`;
	const rows = item.items.map((entry) => html`<li data-depth=${entry.depth || undefined}>${inline(entry.inline)}</li>`);
	return item.ordered ? html`<ol>${rows}</ol>` : html`<ul>${rows}</ul>`;
}

export function Markdown({ text }) {
	const blocks = useMemo(() => parseMarkdown(text), [text]);
	return html`<div class="md">${blocks.map(block)}</div>`;
}
