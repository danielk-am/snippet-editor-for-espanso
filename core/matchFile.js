import { Scalar, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { deepEqual } from '../shared/snippetModel.js';
import { hasOwn, isPlainObject } from '../shared/text.js';

// Reading and rewriting one Espanso match file.
//
// An edit never regenerates the file. The YAML parser is used to find where
// things are, and the change is spliced into the original text at exactly
// those offsets, so every byte outside the edited value stays as you wrote
// it: comments, blank lines, indentation, quoting, `imports`, `global_vars`
// and all the other snippets.
//
// Before an edit is returned, the result is parsed again and compared with
// what was intended: the edited snippet must read back as the new value and
// everything else must read back unchanged. An edit that cannot be shown to
// be exact is refused, and the raw editor is the way to make it.

const UNSAFE = 'This change could not be made safely here. Make it in the raw YAML editor instead.';

// Thrown by the editor for a layout it does not handle. Callers turn it into
// the refusal above; nothing is written.
class Unsupported extends Error {}

// ============================================================================
// Reading
// ============================================================================

// Espanso reads these keys as text. An unquoted `02134` or `+6591234567` is
// therefore those characters to Espanso, even though YAML calls it a number,
// and that is how it is shown and compared here.
const TEXT_KEYS = ['trigger', 'regex', 'replace', 'markdown', 'html', 'form', 'image_path', 'label'];
const TEXT_LIST_KEYS = ['triggers', 'search_terms'];

function asWritten(node, value) {
	const typed = typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint';
	return typed && isScalar(node) && node.type === Scalar.PLAIN && typeof node.source === 'string' ? node.source : value;
}

function readMatch(item, doc) {
	const match = item.toJS(doc);
	for (const pair of item.items) {
		const key = isScalar(pair.key) ? pair.key.value : undefined;
		if (TEXT_KEYS.includes(key)) {
			match[key] = asWritten(pair.value, match[key]);
		} else if (TEXT_LIST_KEYS.includes(key) && isSeq(pair.value) && Array.isArray(match[key])) {
			match[key] = match[key].map((value, index) => asWritten(pair.value.items[index], value));
		}
	}
	return match;
}

function formatError(error) {
	const message = error.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
	const start = error.linePos?.[0];
	return start ? `Line ${start.line}, column ${start.col}: ${message}` : message;
}

function readMatches(doc) {
	if (doc.contents === null) return { seq: null, matches: [], errors: [] };
	if (!isMap(doc.contents)) {
		return { seq: null, matches: null, errors: ['The file must be a mapping with a `matches` list.'] };
	}
	const node = doc.get('matches', true);
	if (node === undefined || (isScalar(node) && node.value === null)) {
		return { seq: null, matches: [], errors: [] };
	}
	if (!isSeq(node)) return { seq: null, matches: null, errors: ['`matches` must be a list of snippets.'] };
	const notMap = node.items.findIndex((item) => !isMap(item));
	if (notMap !== -1) {
		return { seq: null, matches: null, errors: [`Snippet ${notMap + 1} is not a mapping of keys.`] };
	}
	return { seq: node, matches: node.items.map((item) => readMatch(item, doc)), errors: [] };
}

function hasCycle(value, path = new Set()) {
	if (value === null || typeof value !== 'object') return false;
	if (path.has(value)) return true;
	path.add(value);
	const found = Object.values(value).some((child) => hasCycle(child, path));
	path.delete(value);
	return found;
}

// Never throws: whatever is wrong with a file comes back as its `errors`, so
// one bad file is a problem with that file and not with the whole folder.
export function parseMatchFile(text) {
	const header = parseHeaderMeta(text);
	const failed = (doc, errors) => ({ doc, seq: null, matches: null, errors, header });
	let doc = null;
	try {
		doc = parseDocument(text, { prettyErrors: true });
		if (doc.errors.length) return failed(doc, doc.errors.map(formatError));
		// Resolving aliases happens here and can fail on its own: an alias
		// with no anchor, or one that expands without end.
		const read = readMatches(doc);
		if (read.matches && hasCycle(read.matches)) {
			return failed(doc, ['A snippet refers to itself through a YAML alias, so this file cannot be shown as a list.']);
		}
		return { doc, ...read, header };
	} catch (error) {
		return failed(doc, [String(error?.message ?? error).split('\n')[0]]);
	}
}

// ============================================================================
// Writing new values
// ============================================================================

const pad = (count) => ' '.repeat(count);

// Code points a reader cannot see, or that some YAML parsers reject raw:
// controls, no-break and zero-width spaces, direction marks, line separators
// and the byte order mark. Written as numbers so this file holds none of them.
function isInvisible(code) {
	return (
		code < 0x20 ||
		(code >= 0x7f && code <= 0xa0) ||
		code === 0x61c ||
		(code >= 0x2000 && code <= 0x200f) ||
		(code >= 0x2028 && code <= 0x202e) ||
		(code >= 0x2060 && code <= 0x206f) ||
		(code >= 0xd800 && code <= 0xdfff) ||
		code >= 0xfeff && code <= 0xffff && (code === 0xfeff || code >= 0xfffe)
	);
}

// Double quotes can hold any text exactly. JSON's string form is valid YAML,
// and anything invisible that JSON leaves raw is written as an escape.
function quote(text) {
	let out = '';
	for (const char of JSON.stringify(text)) {
		const code = char.codePointAt(0);
		out += code >= 0x7f && isInvisible(code) ? '\\u' + code.toString(16).padStart(4, '0') : char;
	}
	return out;
}

const isPrintable = (text) => [...text].every((char) => char === '\n' || !isInvisible(char.codePointAt(0)));

// Multi-line text reads best as a `|` block, but a block cannot hold every
// string exactly (leading or trailing spaces, blank edges, invisible
// characters). Only text a block is certain to preserve is written as one;
// anything else is quoted.
function fitsBlock(text) {
	if (!text.includes('\n') || text.endsWith('\n\n') || !isPrintable(text)) return false;
	const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
	return lines[0] !== '' && !/^[ \t]/.test(lines[0]) && lines.every((line) => !/[ \t]$/.test(line) && !line.startsWith('\t'));
}

function scalarText(value) {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') {
		if (Number.isFinite(value)) return String(value);
		return Number.isNaN(value) ? '.nan' : value > 0 ? '.inf' : '-.inf';
	}
	if (typeof value === 'bigint') return String(value);
	return quote(String(value));
}

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const WORD_KEY = /^(true|false|null|yes|no|on|off|y|n)$/i;
const renderKey = (key) => (PLAIN_KEY.test(key) && !WORD_KEY.test(key) ? key : quote(key));

// A value as `head` (what follows `key:` or `-` on the same line) plus the
// full lines below it, already indented to `indent`.
function renderNode(value, indent) {
	if (typeof value === 'string') {
		if (!fitsBlock(value)) return { head: quote(value), lines: [] };
		const body = value.endsWith('\n') ? value.slice(0, -1) : value;
		return {
			head: value.endsWith('\n') ? '|' : '|-',
			lines: body.split('\n').map((line) => (line === '' ? '' : pad(indent) + line)),
		};
	}
	if (Array.isArray(value)) {
		if (!value.length) return { head: '[]', lines: [] };
		return { head: '', lines: value.flatMap((item) => renderItem(item, indent)) };
	}
	if (isPlainObject(value)) {
		const keys = Object.keys(value);
		if (!keys.length) return { head: '{}', lines: [] };
		return { head: '', lines: keys.flatMap((key) => renderPair(key, value[key], indent)) };
	}
	return { head: scalarText(value), lines: [] };
}

function renderPair(key, value, indent) {
	const { head, lines } = renderNode(value, indent + 2);
	return [pad(indent) + renderKey(key) + ':' + (head ? ' ' + head : ''), ...lines];
}

// A list item whose dash sits at `indent`. A mapping starts on the dash line.
function renderItem(value, indent) {
	const { head, lines } = renderNode(value, indent + 2);
	if (head || !lines.length) return [pad(indent) + '- ' + head, ...lines];
	if (isPlainObject(value)) return [pad(indent) + '- ' + lines[0].slice(indent + 2), ...lines.slice(1)];
	return [pad(indent) + '-', ...lines];
}

function renderFlow(value) {
	if (Array.isArray(value)) return '[' + value.map(renderFlow).join(', ') + ']';
	if (isPlainObject(value)) {
		return '{' + Object.entries(value).map(([key, item]) => `${renderKey(key)}: ${renderFlow(item)}`).join(', ') + '}';
	}
	return typeof value === 'string' ? quote(value) : scalarText(value);
}

// ============================================================================
// Splicing changes into the original text
// ============================================================================

// Trigger keys and content keys each fill one slot in a snippet. Swapping
// one for another renames the key where it is instead of moving the value to
// the end of the snippet.
const SLOTS = [
	['trigger', 'triggers', 'regex'],
	['replace', 'markdown', 'html', 'form', 'image_path'],
];

class Editor {
	constructor(text) {
		this.text = text;
		const firstBreak = text.indexOf('\n');
		this.eol = firstBreak > 0 && text[firstBreak - 1] === '\r' ? '\r\n' : '\n';
		this.edits = [];
	}

	// --- positions ---------------------------------------------------------

	lineStart(offset) {
		return this.text.lastIndexOf('\n', offset - 1) + 1;
	}

	// Where the visible part of the line ends, before any line break.
	lineEnd(offset) {
		const at = this.text.indexOf('\n', offset);
		if (at === -1) return this.text.length;
		return this.text[at - 1] === '\r' ? at - 1 : at;
	}

	// The start of the next line, or the end of the text.
	afterLine(offset) {
		const at = this.text.indexOf('\n', offset);
		return at === -1 ? this.text.length : at + 1;
	}

	column(offset) {
		return offset - this.lineStart(offset);
	}

	startsLine(offset) {
		return this.text.slice(this.lineStart(offset), offset).trim() === '';
	}

	skipBlankLines(start) {
		let at = start;
		while (this.isBlankLine(at)) at = this.afterLine(at);
		return at;
	}

	isBlankLine(start) {
		return start < this.text.length && this.text.slice(start, this.lineEnd(start)).trim() === '';
	}

	// The end of a node's own text: past its last character, before any
	// trailing comment, space or line break. Never before `floor`.
	contentEnd(node, floor) {
		if (!node?.range) return floor;
		if (isMap(node) && !node.flow && node.items.length) {
			const last = node.items[node.items.length - 1];
			return this.pairEnd(last);
		}
		if (isSeq(node) && !node.flow && node.items.length) {
			const last = node.items[node.items.length - 1];
			return this.contentEnd(last, this.dashOf(last) + 1);
		}
		let end = node.range[1];
		while (end > floor && /\s/.test(this.text[end - 1])) end -= 1;
		return Math.max(end, floor);
	}

	// The start of the first line after everything that belongs to `node`.
	// For most values that is the line after its last character. A block
	// scalar written with `+` also owns the blank lines below it, so text
	// placed any higher would take them away from it.
	blockEnd(node, floor) {
		const keeper = this.keepScalar(node);
		if (keeper) {
			const end = keeper.range[1];
			return end >= this.text.length || this.text[end - 1] === '\n' ? end : this.afterLine(end);
		}
		return this.afterLine(this.contentEnd(node, floor));
	}

	// The `|+` or `>+` scalar that `node` ends with, if it ends with one.
	keepScalar(node) {
		let last = node;
		while ((isMap(last) || isSeq(last)) && !last.flow && last.items.length) {
			const tail = last.items[last.items.length - 1];
			last = isMap(last) ? tail.value : tail;
		}
		const isBlock = isScalar(last) && last.range && (last.type === Scalar.BLOCK_LITERAL || last.type === Scalar.BLOCK_FOLDED);
		return isBlock && /^[|>][0-9-]*\+/.test(this.text.slice(last.range[0], this.lineEnd(last.range[0]))) ? last : null;
	}

	colonEnd(pair) {
		if (!isScalar(pair.key) || !pair.key.range) throw new Unsupported();
		const from = pair.key.range[1];
		const colon = this.text.indexOf(':', from);
		if (colon === -1 || this.text.slice(from, colon).trim() !== '') throw new Unsupported();
		return colon + 1;
	}

	pairEnd(pair) {
		return this.contentEnd(pair.value, this.colonEnd(pair));
	}

	// The dash that introduces a block list item.
	dashOf(item) {
		if (!item?.range) throw new Unsupported();
		let at = item.range[0] - 1;
		while (at >= 0 && /\s/.test(this.text[at])) at -= 1;
		if (this.text[at] !== '-') throw new Unsupported();
		return at;
	}

	// --- edits -------------------------------------------------------------

	replace(start, end, text) {
		this.edits.push({ start, end, text });
	}

	// Whole lines, placed after the line that contains `offset`.
	insertLinesAfter(offset, lines) {
		const at = this.text.indexOf('\n', offset);
		if (at === -1) this.replace(this.text.length, this.text.length, this.eol + lines.join(this.eol));
		else this.replace(at + 1, at + 1, lines.join(this.eol) + this.eol);
	}

	// Whole lines, placed at the start of a line (or at the end of the text).
	insertLinesAt(offset, lines) {
		const atOpenEnd = offset === this.text.length && this.text.length > 0 && !this.text.endsWith('\n');
		this.replace(offset, offset, atOpenEnd ? this.eol + lines.join(this.eol) : lines.join(this.eol) + this.eol);
	}

	// Removing whole lines from a file that does not end in a line break
	// must not leave it ending in one.
	removeLines(start, end, keepBreakAbove = false) {
		if (!keepBreakAbove && end === this.text.length && start > 0 && !this.text.endsWith('\n')) {
			start -= this.text[start - 2] === '\r' ? 2 : 1;
		}
		this.replace(start, end, '');
	}

	apply() {
		const edits = [...this.edits].sort((a, b) => a.start - b.start || a.end - b.end);
		let out = '';
		let cursor = 0;
		for (const edit of edits) {
			if (edit.start < cursor) throw new Unsupported();
			out += this.text.slice(cursor, edit.start) + edit.text;
			cursor = edit.end;
		}
		return out + this.text.slice(cursor);
	}

	// --- values ------------------------------------------------------------

	// Put `value` where `node` is. `floor` is just past the `:` or `-` that
	// introduces the node, and `indent` is the column of that key or dash.
	replaceValue(node, value, { floor, indent, item }) {
		const end = this.contentEnd(node, floor);
		let { head, lines } = renderNode(value, indent + 2);
		if (item && !head && lines.length && isPlainObject(value)) {
			head = lines[0].slice(indent + 2);
			lines = lines.slice(1);
		}
		const lead = head ? ' ' + head : '';
		if (!lines.length) return this.replace(floor, end, lead);

		// A comment after a one-line value stays on that line, with the new
		// lines below it. Left where it was, it would become part of a block.
		const sameLineRest = this.text.slice(end, this.lineEnd(end)).trim();
		const wasOneLine = !this.text.slice(floor, end).includes('\n');
		if (wasOneLine && sameLineRest) {
			this.replace(floor, end, lead);
			this.insertLinesAfter(end, lines);
		} else {
			this.replace(floor, end, lead + this.eol + lines.join(this.eol));
		}
	}

	// Change `node` from `before` to `after`, touching as little as possible:
	// mappings and lists are changed key by key and item by item.
	patchNode(node, before, after, place) {
		if (isMap(node) && node.items.length && isPlainObject(before) && isPlainObject(after) && Object.keys(after).length) {
			return this.patchMap(node, before, after);
		}
		if (isSeq(node) && node.items.length === before?.length && Array.isArray(before) && Array.isArray(after) && after.length) {
			return this.patchSeq(node, before, after);
		}
		if (place.flow) return this.replace(node.range[0], this.contentEnd(node, node.range[0]), renderFlow(after));
		return this.replaceValue(node, after, place);
	}

	// --- mappings ----------------------------------------------------------

	patchMap(map, before, after) {
		const pairs = new Map(
			map.items.map((pair) => {
				if (!isScalar(pair.key)) throw new Unsupported();
				return [String(pair.key.value), pair];
			})
		);
		// A key that reaches the mapping some other way (a merge) cannot be
		// edited in place.
		const pairOf = (key) => pairs.get(key) ?? fail();
		const fail = () => {
			throw new Unsupported();
		};

		const removed = Object.keys(before).filter((key) => !hasOwn(after, key));
		const added = Object.keys(after).filter((key) => !hasOwn(before, key));
		const changed = Object.keys(after).filter((key) => hasOwn(before, key) && !deepEqual(before[key], after[key]));

		if (map.flow) {
			if (removed.length || added.length) {
				return this.replace(map.range[0], this.contentEnd(map, map.range[0]), renderFlow(after));
			}
			for (const key of changed) {
				const { value } = pairOf(key);
				if (!value?.range) throw new Unsupported();
				this.patchNode(value, before[key], after[key], { flow: true });
			}
			return;
		}

		const indent = this.column(map.items[0].key.range[0]);
		const rename = (from, to) => {
			const pair = pairOf(from);
			this.replace(pair.key.range[0], pair.key.range[1], renderKey(to));
			if (!deepEqual(before[from], after[to])) {
				this.replaceValue(pair.value, after[to], { floor: this.colonEnd(pair), indent });
			}
			removed.splice(removed.indexOf(from), 1);
			added.splice(added.indexOf(to), 1);
		};

		for (const slot of SLOTS) {
			const out = removed.filter((key) => slot.includes(key));
			const into = added.filter((key) => slot.includes(key));
			if (out.length === 1 && into.length === 1) rename(out[0], into[0]);
		}
		// The first key shares its line with the list dash. If it goes and a
		// new key arrives, the new key takes its place.
		const firstKey = String(map.items[0].key.value);
		if (removed.includes(firstKey) && added.length && !this.startsLine(map.items[0].key.range[0])) rename(firstKey, added[0]);

		for (const key of removed) this.removePair(map, pairOf(key));
		for (const key of changed) {
			const pair = pairOf(key);
			this.patchNode(pair.value, before[key], after[key], { floor: this.colonEnd(pair), indent });
		}
		if (added.length) {
			const last = map.items[map.items.length - 1];
			this.insertLinesAt(
				this.blockEnd(last.value, this.colonEnd(last)),
				added.flatMap((key) => renderPair(key, after[key], indent))
			);
		}
	}

	removePair(map, pair) {
		const start = pair.key.range[0];
		if (this.startsLine(start)) {
			const above = map.items[map.items.indexOf(pair) - 1];
			const end = this.blockEnd(pair.value, this.colonEnd(pair));
			const owned = Boolean(above && this.keepScalar(above.value));
			return this.removeLines(this.lineStart(start), owned ? this.skipBlankLines(end) : end, owned);
		}
		// On the dash line: pull the next key up to take its place.
		const next = map.items[map.items.indexOf(pair) + 1];
		if (!next) throw new Unsupported();
		this.replace(start, next.key.range[0], '');
	}

	// --- lists -------------------------------------------------------------

	patchSeq(seq, before, after) {
		if (seq.flow) {
			if (before.length !== after.length) {
				return this.replace(seq.range[0], this.contentEnd(seq, seq.range[0]), renderFlow(after));
			}
			after.forEach((value, index) => {
				if (!deepEqual(before[index], value)) this.patchNode(seq.items[index], before[index], value, { flow: true });
			});
			return;
		}

		const without = (list, skip) => list.filter((_, index) => index !== skip);
		const dashes = seq.items.map((item) => this.dashOf(item));

		// One item removed or one added is the usual edit. Handling it as
		// that keeps every other item, and its comments, exactly in place.
		if (after.length === before.length - 1) {
			for (let index = before.length - 1; index >= 0; index -= 1) {
				if (deepEqual(without(before, index), after)) return this.removeItem(seq, index, dashes);
			}
		}
		if (after.length === before.length + 1) {
			for (let index = after.length - 1; index >= 0; index -= 1) {
				if (deepEqual(without(after, index), before)) return this.insertItems(seq, index, [after[index]], dashes);
			}
		}

		const shared = Math.min(before.length, after.length);
		for (let index = 0; index < shared; index += 1) {
			if (deepEqual(before[index], after[index])) continue;
			this.patchNode(seq.items[index], before[index], after[index], {
				floor: dashes[index] + 1,
				indent: this.column(dashes[index]),
				item: true,
			});
		}
		for (let index = before.length - 1; index >= shared; index -= 1) this.removeItem(seq, index, dashes);
		if (after.length > shared) this.insertItems(seq, shared, after.slice(shared), dashes);
	}

	itemEnd(seq, index, dashes) {
		return this.contentEnd(seq.items[index], dashes[index] + 1);
	}

	// Whether the list separates its items with blank lines.
	isSpaced(seq, dashes) {
		return dashes.some((dash, index) => index > 0 && /\n[ \t]*\r?\n/.test(this.text.slice(this.itemEnd(seq, index - 1, dashes), dash)));
	}

	removeItem(seq, index, dashes) {
		const dash = dashes[index];
		if (!this.startsLine(dash)) throw new Unsupported();
		let start = this.lineStart(dash);
		let end = this.blockEnd(seq.items[index], dashes[index] + 1);
		// A blank line on both sides would leave two together: take one.
		// Not when the lines above belong to a `|+` value of the item before.
		const ownedAbove = index > 0 && this.keepScalar(seq.items[index - 1]);
		// Blank lines left directly under a `|+` value would become part of
		// it, so they go with the item that separated them from it.
		if (ownedAbove) end = this.skipBlankLines(end);
		const blankAbove = !ownedAbove && start > 0 && this.isBlankLine(this.lineStart(start - 1));
		if (blankAbove && this.isBlankLine(end)) end = this.afterLine(end);
		else if (blankAbove && end === this.text.length) start = this.lineStart(start - 1);
		// The line break above a `|+` value's last line is part of that value.
		this.removeLines(start, end, Boolean(ownedAbove));
	}

	insertItems(seq, at, values, dashes) {
		if (!this.startsLine(dashes[0])) throw new Unsupported();
		const indent = this.column(dashes[0]);
		const spaced = this.isSpaced(seq, dashes);
		const blocks = values.map((value) => renderItem(value, indent));

		if (at > 0) {
			// The separating blank line goes above the new item, unless that
			// would hand it to a `|+` value ending the item before.
			const below = this.keepScalar(seq.items[at - 1]);
			const lines = blocks.flatMap((block) => (!spaced ? block : below ? [...block, ''] : ['', ...block]));
			return this.insertLinesAt(this.blockEnd(seq.items[at - 1], dashes[at - 1] + 1), lines);
		}
		// Before the first item, and above the comment lines that introduce
		// it: those belong to the item they sit on.
		let start = this.lineStart(dashes[0]);
		while (start > 0) {
			const above = this.lineStart(start - 1);
			if (!this.text.slice(above, start).trim().startsWith('#')) break;
			start = above;
		}
		const lines = blocks.flatMap((block) => (spaced ? [...block, ''] : block));
		this.replace(start, start, lines.join(this.eol) + this.eol);
	}
}

// ============================================================================
// The edits a caller can ask for
// ============================================================================

function open(text) {
	const parsed = parseMatchFile(text);
	if (parsed.errors.length) throw new Error(parsed.errors.join(' '));
	return parsed;
}

function checkPosition(matches, index) {
	if (!Number.isInteger(index) || index < 0 || index >= matches.length) {
		throw new Error(`No snippet at position ${index}.`);
	}
}

// Everything in the file that is not the snippet list, as values.
function surroundings(doc) {
	const all = doc.toJS() ?? {};
	if (!isPlainObject(all)) return all;
	const { matches, ...rest } = all;
	return rest;
}

// Run the edit, then prove it: the file must still parse, the snippets must
// read back as intended, and nothing around them may have changed.
function commit(before, expected, change) {
	const editor = new Editor(before.text);
	try {
		change(editor);
		const next = editor.apply();
		const after = parseMatchFile(next);
		const exact = !after.errors.length && deepEqual(after.matches, expected) && deepEqual(surroundings(after.doc), surroundings(before.doc));
		if (exact) return next;
	} catch (error) {
		if (!(error instanceof Unsupported) && !(error instanceof TypeError) && !(error instanceof ReferenceError)) throw error;
	}
	throw new Error(UNSAFE);
}

const matchesPair = (doc) => doc.contents.items.find((pair) => isScalar(pair.key) && pair.key.value === 'matches');

export function applyMatchUpdate(text, index, match) {
	const before = { ...open(text), text };
	checkPosition(before.matches, index);
	if (deepEqual(before.matches[index], match)) return text;
	const expected = before.matches.map((existing, at) => (at === index ? match : existing));
	return commit(before, expected, (editor) => editor.patchMap(before.seq.items[index], before.matches[index], match));
}

export function insertMatch(text, match, index) {
	const before = { ...open(text), text };
	const count = before.matches.length;
	const at = Number.isInteger(index) ? Math.max(0, Math.min(index, count)) : count;
	const expected = [...before.matches.slice(0, at), match, ...before.matches.slice(at)];

	return commit(before, expected, (editor) => {
		const { doc, seq } = before;
		if (seq?.items.length) {
			if (seq.flow) throw new Unsupported();
			return editor.insertItems(seq, at, [match], seq.items.map((item) => editor.dashOf(item)));
		}
		// An empty list (`matches: []`, or `matches:` with nothing after it).
		const pair = isMap(doc.contents) ? matchesPair(doc) : undefined;
		if (pair) {
			return editor.replaceValue(pair.value, [match], { floor: editor.colonEnd(pair), indent: editor.column(pair.key.range[0]) });
		}
		// No `matches` key yet: add one at the end of the file.
		if (doc.contents !== null && (!isMap(doc.contents) || doc.contents.flow)) throw new Unsupported();
		const lines = ['matches:', ...renderItem(match, 2)].join(editor.eol) + editor.eol;
		if (!text.trim()) return editor.replace(text.length, text.length, lines);
		const gap = (text.endsWith('\n') ? '' : editor.eol) + (/\n[ \t]*\r?\n$/.test(text) ? '' : editor.eol);
		editor.replace(text.length, text.length, gap + lines);
	});
}

export function removeMatch(text, index) {
	const before = { ...open(text), text };
	checkPosition(before.matches, index);
	const expected = before.matches.filter((_, at) => at !== index);

	return commit(before, expected, (editor) => {
		const { doc, seq } = before;
		if (seq.flow) throw new Unsupported();
		editor.removeItem(seq, index, seq.items.map((item) => editor.dashOf(item)));
		// Say that the list is now empty, instead of leaving a bare key.
		if (seq.items.length === 1) {
			const colon = editor.colonEnd(matchesPair(doc));
			editor.replace(colon, colon, ' []');
		}
	});
}

// One snippet as the YAML this app writes for it, for the preview.
export function stringifyMatch(match) {
	return renderItem(match, 0).join('\n') + '\n';
}

// ============================================================================
// Header comment metadata
// ============================================================================

// Espanso has no file-level metadata, so a file's description and trigger
// prefix live in its leading comment block:
//
//     # Greetings for support replies
//     # prefix: ";"

const BOM = String.fromCharCode(0xfeff);
const PREFIX_LINE = /^#\s*prefix:\s*(.*?)\s*$/i;
// Comment lines that mean something to other tools, and are left alone.
const TOOL_LINE = /^#!|^#\s*yaml-language-server:/i;

const withoutBreak = (line) => line.replace(/\r?\n$/, '');
const isPrefixLine = (line) => PREFIX_LINE.test(withoutBreak(line));
// A description has words in it: a row of `#####` is decoration.
const isDescriptionLine = (line) => !isPrefixLine(line) && !TOOL_LINE.test(line) && /[\p{L}\p{N}]/u.test(line);
const describedBy = (line) => withoutBreak(line).replace(/^#+\s?/, '').trim();

function splitHeader(text) {
	const bom = text.startsWith(BOM) ? BOM : '';
	const lines = text.slice(bom.length).match(/[^\n]*\n|[^\n]+$/g) ?? [];
	let end = 0;
	while (end < lines.length && lines[end].startsWith('#')) end += 1;
	const eol = lines[0]?.endsWith('\r\n') ? '\r\n' : '\n';
	return { bom, header: lines.slice(0, end), rest: lines.slice(end), eol };
}

function unquote(raw) {
	const value = raw.trim();
	if (value.startsWith('"')) {
		try {
			return String(JSON.parse(value));
		} catch {
			return value.replace(/^"|"$/g, '');
		}
	}
	if (value.startsWith("'")) return value.replace(/^'|'$/g, '').replace(/''/g, "'");
	return value;
}

export function parseHeaderMeta(text) {
	const { header } = splitHeader(text);
	const meta = { description: '', prefix: '' };
	for (const line of header) {
		const prefix = withoutBreak(line).match(PREFIX_LINE);
		if (prefix) meta.prefix = unquote(prefix[1]);
		else if (!meta.description && isDescriptionLine(line)) meta.description = describedBy(line);
	}
	return meta;
}

// Changes only the line that holds what changed. Details that are the same
// as before leave the file exactly as it was.
export function writeHeaderMeta(text, { description = '', prefix = '' }) {
	const { bom, header, rest, eol } = splitHeader(text);
	const current = parseHeaderMeta(text);
	const wanted = description.replace(/[\r\n]+/g, ' ').trim();
	if (/^prefix:/i.test(wanted) || TOOL_LINE.test(`# ${wanted}`)) {
		throw new Error('A description cannot start with "prefix:" or "yaml-language-server:".');
	}
	if (wanted === current.description && prefix === current.prefix) return text;

	const hadHeader = header.length > 0;
	const lines = [...header];
	// New lines go below any tool lines, which usually have to come first.
	const afterToolLines = () => {
		let at = 0;
		while (at < lines.length && TOOL_LINE.test(lines[at])) at += 1;
		return at;
	};
	const set = (at, content, insertAt) => {
		if (at !== -1 && content) lines[at] = content + (lines[at].match(/\r?\n$/)?.[0] ?? eol);
		else if (at !== -1) lines.splice(at, 1);
		else if (content) lines.splice(insertAt(), 0, content + eol);
	};

	if (wanted !== current.description) {
		set(lines.findIndex(isDescriptionLine), wanted && `# ${wanted}`, afterToolLines);
	}
	if (prefix !== current.prefix) {
		set(lines.findIndex(isPrefixLine), prefix && `# prefix: ${JSON.stringify(prefix)}`, () => {
			const described = lines.findIndex(isDescriptionLine);
			return described === -1 ? afterToolLines() : described + 1;
		});
	}

	// A header that ends the file needs its own line break before content.
	if (lines.length && rest.length && !/\n$/.test(lines[lines.length - 1])) lines[lines.length - 1] += eol;
	// A new header is set apart from the content by a blank line, and
	// removing the whole header takes that blank line with it.
	const body = [...rest];
	if (!hadHeader && lines.length && body.length && body[0].trim() !== '') body.unshift(eol);
	if (hadHeader && !lines.length && body.length && body[0].trim() === '') body.shift();
	return bom + lines.join('') + body.join('');
}

export function newFileText({ description = '', prefix = '' } = {}) {
	return writeHeaderMeta('matches: []\n', { description, prefix });
}
