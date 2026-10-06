// The assistant's Markdown, read into plain data: a list of blocks, each
// holding inline parts. A component turns that data into elements one by
// one. Nothing here or there ever builds HTML text, so whatever an answer
// contains, a snippet's own text included, can only ever be shown as text.
//
// Read: paragraphs, headings, bullet and numbered lists (three levels),
// quotes, rules, fenced code, and inside a line bold, italic and code.
// A link becomes its words and its address, as text: nothing in an answer
// is clickable. A table is kept as lined-up text. HTML is text.

// How far ahead a closing mark is looked for. An answer is written by a
// model, but its text can come from anywhere, and this keeps the reading
// of any text quick.
const REACH = 1000;
const MAX_DEPTH = 4;

const runOf = (text, at, mark) => {
	let end = at;
	while (text[end] === mark) end += 1;
	return end - at;
};

// Where a run of exactly `length` backticks starts, at or after `from`.
function closingTicks(text, from, length) {
	const limit = Math.min(text.length, from + REACH * 5);
	for (let at = from; at < limit; at += 1) {
		if (text[at] !== '`') continue;
		const run = runOf(text, at, '`');
		if (run === length) return at;
		at += run - 1;
	}
	return -1;
}

const isWordy = (char) => char !== undefined && /[A-Za-z0-9]/.test(char);

// Where the run of `mark` that closes an emphasis opened before `from` starts.
function closingMark(text, from, mark, length) {
	const limit = Math.min(text.length, from + REACH);
	for (let at = from; at < limit; at += 1) {
		const char = text[at];
		if (char === '\\') at += 1;
		else if (char === '`') {
			const run = runOf(text, at, '`');
			const close = closingTicks(text, at + run, run);
			at = close === -1 ? at + run - 1 : close + run - 1;
		} else if (char === mark) {
			const run = runOf(text, at, mark);
			if (run === length && at > from && !/\s/.test(text[at - 1]) && (mark === '*' || !isWordy(text[at + run]))) return at;
			at += run - 1;
		}
	}
	return -1;
}

// "[words](address)" starting at `at`, or null.
function linkAt(text, at) {
	let depth = 0;
	let close = -1;
	for (let index = at; index < Math.min(text.length, at + REACH); index += 1) {
		if (text[index] === '\\') index += 1;
		else if (text[index] === '[') depth += 1;
		else if (text[index] === ']') {
			depth -= 1;
			if (depth === 0) {
				close = index;
				break;
			}
		}
	}
	if (close === -1 || text[close + 1] !== '(') return null;
	let open = 0;
	for (let index = close + 1; index < Math.min(text.length, close + 1 + REACH * 2); index += 1) {
		if (text[index] === '(') open += 1;
		else if (text[index] === ')') {
			open -= 1;
			if (open === 0) return { words: text.slice(at + 1, close), address: text.slice(close + 2, index).trim(), end: index + 1 };
		} else if (text[index] === '\n') return null;
	}
	return null;
}

function inline(text, depth = 0) {
	const parts = [];
	let plain = '';
	const flush = () => {
		if (plain) parts.push({ type: 'text', text: plain });
		plain = '';
	};

	for (let at = 0; at < text.length; ) {
		const char = text[at];

		if (char === '\\' && at + 1 < text.length && /[\\`*_{}[\]()#+\-.!>~|]/.test(text[at + 1])) {
			plain += text[at + 1];
			at += 2;
		} else if (char === '`') {
			const run = runOf(text, at, '`');
			const close = closingTicks(text, at + run, run);
			if (close === -1) {
				plain += text.slice(at, at + run);
				at += run;
			} else {
				flush();
				let inner = text.slice(at + run, close);
				if (inner.startsWith(' ') && inner.endsWith(' ') && inner.trim()) inner = inner.slice(1, -1);
				parts.push({ type: 'code', text: inner });
				at = close + run;
			}
		} else if (char === '[' || (char === '!' && text[at + 1] === '[')) {
			const link = linkAt(text, char === '!' ? at + 1 : at);
			if (link) {
				plain += !link.words || link.words === link.address ? link.address : `${link.words} (${link.address})`;
				at = link.end;
			} else {
				plain += char;
				at += 1;
			}
		} else if (char === '*' || char === '_') {
			const run = runOf(text, at, char);
			const next = text[at + run];
			const opens = run <= 3 && depth < MAX_DEPTH && next !== undefined && !/\s/.test(next) && (char === '*' || !isWordy(text[at - 1]));
			const close = opens ? closingMark(text, at + run, char, run) : -1;
			if (close === -1) {
				plain += text.slice(at, at + run);
				at += run;
			} else {
				flush();
				const children = inline(text.slice(at + run, close), depth + 1);
				parts.push(run === 1 ? { type: 'em', children } : run === 2 ? { type: 'strong', children } : { type: 'strong', children: [{ type: 'em', children }] });
				at = close + run;
			}
		} else {
			plain += char;
			at += 1;
		}
	}
	flush();
	return parts;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(\S.*)$/;
const TABLE = /^\s*\|/;

export function parseMarkdown(input) {
	if (input === null || input === undefined) return [];
	const lines = String(input).replace(/\r\n?/g, '\n').split('\n');
	const blocks = [];
	let paragraph = [];
	const endParagraph = () => {
		const text = paragraph.join('\n').trimEnd();
		if (text.trim()) blocks.push({ type: 'paragraph', inline: inline(text) });
		paragraph = [];
	};

	for (let at = 0; at < lines.length; ) {
		const line = lines[at];
		const fence = FENCE.exec(line);

		if (fence) {
			endParagraph();
			const [, marks, language] = fence;
			const closes = (candidate) => {
				const found = FENCE.exec(candidate);
				return Boolean(found) && found[1][0] === marks[0] && found[1].length >= marks.length && !found[2];
			};
			const body = [];
			at += 1;
			// One left open runs to the end: an answer still being written.
			while (at < lines.length && !closes(lines[at])) {
				body.push(lines[at]);
				at += 1;
			}
			at += 1;
			blocks.push({ type: 'code', language, text: body.join('\n') });
		} else if (!line.trim()) {
			endParagraph();
			at += 1;
		} else if (HEADING.test(line)) {
			endParagraph();
			const [, marks, text] = HEADING.exec(line);
			blocks.push({ type: 'heading', level: marks.length, inline: inline(text) });
			at += 1;
		} else if (RULE.test(line)) {
			endParagraph();
			blocks.push({ type: 'rule' });
			at += 1;
		} else if (QUOTE.test(line)) {
			endParagraph();
			const quoted = [];
			while (at < lines.length && QUOTE.test(lines[at])) {
				quoted.push(QUOTE.exec(lines[at])[1]);
				at += 1;
			}
			blocks.push({ type: 'quote', inline: inline(quoted.join('\n').trimEnd()) });
		} else if (TABLE.test(line)) {
			endParagraph();
			const rows = [];
			while (at < lines.length && TABLE.test(lines[at])) {
				rows.push(lines[at]);
				at += 1;
			}
			blocks.push({ type: 'code', language: 'table', text: rows.join('\n') });
		} else if (ITEM.test(line)) {
			endParagraph();
			const ordered = /\d/.test(ITEM.exec(line)[2]);
			const items = [];
			while (at < lines.length) {
				const item = ITEM.exec(lines[at]);
				if (item && !RULE.test(lines[at])) {
					const depth = Math.min(3, Math.floor(item[1].replaceAll('\t', '    ').length / 2));
					// The other kind of list, at the left edge, is a list of its own.
					if (depth === 0 && /\d/.test(item[2]) !== ordered) break;
					items.push({ depth, text: item[3] });
					at += 1;
				} else if (!lines[at].trim()) {
					let next = at + 1;
					while (next < lines.length && !lines[next].trim()) next += 1;
					if (next >= lines.length || !ITEM.test(lines[next])) break;
					at = next;
				} else if (/^\s+\S/.test(lines[at])) {
					// An item that runs on to the next line.
					items.at(-1).text += `\n${lines[at].trim()}`;
					at += 1;
				} else break;
			}
			blocks.push({ type: 'list', ordered, items: items.map((item) => ({ depth: item.depth, inline: inline(item.text.trimEnd()) })) });
		} else {
			paragraph.push(line);
			at += 1;
		}
	}
	endParagraph();
	return blocks;
}
