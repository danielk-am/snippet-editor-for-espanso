// Substring search over the fields a person would remember a snippet by.
// A scan, not an index: a personal match folder holds hundreds of snippets,
// not millions.

import { toText } from './text.js';

const TRIGGER_FIELDS = ['trigger', 'triggers', 'regex'];
const OTHER_FIELDS = ['label', 'search_terms', 'replace', 'markdown', 'html', 'form', 'image_path'];

function fieldText(match, fields) {
	return fields
		.flatMap((field) => {
			const value = match[field];
			if (value === undefined || value === null) return [];
			return Array.isArray(value) ? value.map(toText) : [toText(value)];
		})
		.join('\n')
		.toLowerCase();
}

export function searchFiles(files, query, { limit = 200 } = {}) {
	const terms = String(query ?? '')
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	if (!terms.length) return [];

	const hits = [];
	for (const file of files) {
		if (!Array.isArray(file.matches)) continue;
		file.matches.forEach((match, index) => {
			const triggers = fieldText(match, TRIGGER_FIELDS);
			const rest = fieldText(match, OTHER_FIELDS);
			if (!terms.every((term) => triggers.includes(term) || rest.includes(term))) return;
			hits.push({
				fileId: file.id,
				fileName: file.name,
				source: file.source,
				package: file.package,
				index,
				match,
				inTrigger: terms.some((term) => triggers.includes(term)),
			});
		});
	}

	// Stable sort: trigger hits first, file and list order otherwise.
	hits.sort((a, b) => Number(b.inTrigger) - Number(a.inTrigger));
	return hits.slice(0, limit);
}

// --- the closest matches to a sentence ------------------------------------
//
// The search above wants every word to appear, and a sentence never passes
// that. This one is for a message written to the assistant: the words of the
// asking are set aside, and a snippet is kept when it holds enough of the rest.

const NAMED_FIELDS = ['label', 'search_terms'];
const BODY_FIELDS = ['replace', 'markdown', 'html', 'form', 'image_path'];
const MAX_WORDS = 12;
const MAX_WORD = 60;
const MAX_PIECE = 200;

// Words that say what is wanted, or answer what was said, not what a snippet holds.
const ASKING = new Set(
	`a about add again all also am an and any are as at be been better but by call called can change changes cool
	could create delete did do does done draft edit else expand expanding expands explain file files find fine fix
	for from get give good great had has have help her here him his how i if in instead into is it its just like
	list longer look make me my name named need new nice no nope not now of okay on one open or our out perfect
	please put remove rename reword said say saying says search see shorter should show snippet snippets so some
	sure tell text than that the their them then there these they this those tidy to trigger triggers type typed
	up update us use want was we were what when where which who why will with worked would write yeah yep yes
	you your`.split(/\s+/)
);

const LETTER = /[\p{L}\p{N}]/u;
// What a word may be wrapped in: quotes, brackets, and the marks Markdown puts round code and emphasis.
const OPENING = /^["'“”‘’«([{<`*]+/;
const CLOSING = /["'“”‘’»)\]}>.,!?:;…`*]+$/;
const AROUND = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const SHORTENED = /(?:n['’]t|['’](?:s|t|re|ve|ll|d|m))$/;
// Words run together: "out-of-office", "email/phone", and the two long dashes.
const JOINED = new RegExp(`[/\\-${String.fromCharCode(0x2013, 0x2014)}]+`);
const FILE_NAME = /\.ya?ml$/;
// A trigger named with its sign also finds the triggers that start with it,
// when it is long enough for that to mean something: ":D" is a smiley.
const MIN_START = 3;

// The word, and the shorter words it is also looked for as.
function formsOf(word) {
	const forms = [word];
	const add = (form) => {
		if (form.length >= 4 && !forms.includes(form)) forms.push(form);
	};
	// "stopp" from "stopped" is also tried as "stop".
	const cut = (ending) => {
		const stem = word.slice(0, -ending.length);
		add(stem);
		if (stem.length > 1 && stem.at(-1) === stem.at(-2)) add(stem.slice(0, -1));
	};
	if (word.endsWith('s') && !word.endsWith('ss')) add(word.slice(0, -1));
	if (word.endsWith('es')) add(word.slice(0, -2));
	if (word.endsWith('ies')) add(`${word.slice(0, -3)}y`);
	if (word.endsWith('ing')) cut('ing');
	if (word.endsWith('ed')) cut('ed');
	return forms;
}

export function keywordsOf(text) {
	const found = [];
	if (typeof text !== 'string') return found;
	const take = (word, sign) => {
		if (found.length === MAX_WORDS) return;
		if (!LETTER.test(word) || word.length < (sign ? 2 : 3)) return;
		if (!sign && ASKING.has(word)) return;
		if (found.some((item) => item.word === word)) return;
		found.push({ word, sign, forms: sign ? [word] : formsOf(word) });
	};
	for (const piece of text.split(/\s+/)) {
		if (found.length === MAX_WORDS) break;
		// Only the start of an enormous word is looked at: the trimming below
		// would otherwise take time that grows with the square of its length.
		const start = piece.slice(0, MAX_PIECE).replace(OPENING, '').toLowerCase();
		// A word that starts with a sign is most likely a trigger: kept whole.
		if (start !== '' && !LETTER.test(start[0])) take(start.replace(CLOSING, '').slice(0, MAX_WORD), true);
		else if (!FILE_NAME.test(start.replace(CLOSING, ''))) for (const part of start.split(JOINED)) take(part.replace(SHORTENED, '').replace(AROUND, '').slice(0, MAX_WORD), false);
	}
	return found;
}

const FIRST = { local: 0, team: 1, package: 2 };

// The triggers of a snippet, one by one: a trigger named with its sign is
// matched against each, not looked for anywhere inside them.
function triggerList(match) {
	return TRIGGER_FIELDS.flatMap((field) => {
		const value = match[field];
		if (value === undefined || value === null) return [];
		return (Array.isArray(value) ? value : [value]).map((item) => toText(item).toLowerCase());
	});
}

export function likelyFiles(files, text, { limit = 8 } = {}) {
	const words = keywordsOf(text);
	if (!words.length) return [];
	const enough = Math.ceil(words.length / 2);

	const hits = [];
	for (const file of files) {
		if (!Array.isArray(file.matches)) continue;
		file.matches.forEach((match, index) => {
			if (match === null || typeof match !== 'object' || Array.isArray(match)) return;
			const each = triggerList(match);
			const triggers = each.join('\n');
			const named = fieldText(match, NAMED_FIELDS);
			const body = fieldText(match, BODY_FIELDS);
			let matched = 0;
			let weight = 0;
			let inTrigger = false;
			// 2: a trigger is named exactly. 1: a trigger starts with what was named.
			let byName = 0;
			for (const { word, forms, sign } of words) {
				let worth;
				if (sign) {
					const how = each.includes(word) ? 2 : word.length >= MIN_START && each.some((trigger) => trigger.startsWith(word)) ? 1 : 0;
					byName = Math.max(byName, how);
					worth = how ? 4 : 0;
				} else {
					const within = (field) => forms.some((form) => field.includes(form));
					worth = within(triggers) ? 4 : within(named) ? 3 : within(body) ? 1 : 0;
				}
				if (!worth) continue;
				matched += 1;
				weight += worth;
				if (worth === 4) inTrigger = true;
			}
			// A trigger written out with its sign is asked for by name.
			if (matched < enough && !byName) return;
			hits.push({ fileId: file.id, fileName: file.name, source: file.source, package: file.package, index, match, inTrigger, matched, weight, byName });
		});
	}

	// Stable sort: file and list order where nothing else tells two apart.
	hits.sort((a, b) => b.byName - a.byName || b.matched - a.matched || b.weight - a.weight || (FIRST[a.source] ?? 3) - (FIRST[b.source] ?? 3));
	return hits.slice(0, limit).map(({ byName, ...hit }) => hit);
}
