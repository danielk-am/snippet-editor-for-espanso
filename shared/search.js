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

// Words that say what is wanted, not what a snippet holds.
const ASKING = new Set(
	`a about add all also am an and any are as at be been but by call called can change changes could create
	delete did do does done draft edit else expand expands explain file files find fix for from get give had has
	have help her here him his how i if in instead into is it its just like list look make me my name named need
	new no not now of on one open or our out please put remove rename reword said say saying says search see
	should show snippet snippets so some tell text than that the their them then there these they this those tidy
	to trigger triggers type typed up update us use want was we were what when where which who why will with
	would write you your`.split(/\s+/)
);

const LETTER = /[\p{L}\p{N}]/u;
const OPENING = /^["'“”‘’«([{<]+/;
const CLOSING = /["'“”‘’»)\]}>.,!?:;…]+$/;
const AROUND = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const SHORTENED = /(?:n['’]t|['’](?:s|t|re|ve|ll|d|m))$/;

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
	for (const piece of text.split(/\s+/)) {
		if (found.length === MAX_WORDS) break;
		// Only the start of an enormous word is looked at: the trimming below
		// would otherwise take time that grows with the square of its length.
		let word = piece.slice(0, MAX_PIECE).replace(OPENING, '').toLowerCase();
		// A word that starts with a sign is most likely a trigger: kept whole.
		const sign = word !== '' && !LETTER.test(word[0]);
		word = (sign ? word.replace(CLOSING, '') : word.replace(SHORTENED, '').replace(AROUND, '')).slice(0, MAX_WORD);
		if (!LETTER.test(word) || word.length < (sign ? 2 : 3)) continue;
		if (!sign && ASKING.has(word)) continue;
		if (found.some((item) => item.word === word)) continue;
		found.push({ word, sign, forms: sign ? [word] : formsOf(word) });
	}
	return found;
}

const FIRST = { local: 0, team: 1, package: 2 };

export function likelyFiles(files, text, { limit = 8 } = {}) {
	const words = keywordsOf(text);
	if (!words.length) return [];
	const enough = Math.ceil(words.length / 2);

	const hits = [];
	for (const file of files) {
		if (!Array.isArray(file.matches)) continue;
		file.matches.forEach((match, index) => {
			if (match === null || typeof match !== 'object' || Array.isArray(match)) return;
			const triggers = fieldText(match, TRIGGER_FIELDS);
			const named = fieldText(match, NAMED_FIELDS);
			const body = fieldText(match, BODY_FIELDS);
			let matched = 0;
			let weight = 0;
			let inTrigger = false;
			let bySign = false;
			for (const { forms, sign } of words) {
				const within = (field) => forms.some((form) => field.includes(form));
				const worth = within(triggers) ? 4 : within(named) ? 3 : within(body) ? 1 : 0;
				if (!worth) continue;
				matched += 1;
				weight += worth;
				if (worth === 4) {
					inTrigger = true;
					if (sign) bySign = true;
				}
			}
			// A trigger written out with its sign is asked for by name.
			if (matched < enough && !bySign) return;
			hits.push({ fileId: file.id, fileName: file.name, source: file.source, package: file.package, index, match, inTrigger, matched, weight, bySign });
		});
	}

	// Stable sort: file and list order where nothing else tells two apart.
	hits.sort((a, b) => Number(b.bySign) - Number(a.bySign) || b.matched - a.matched || b.weight - a.weight || (FIRST[a.source] ?? 3) - (FIRST[b.source] ?? 3));
	return hits.slice(0, limit).map(({ bySign, ...hit }) => hit);
}
