// The editor's view of one Espanso match. Pure functions shared by the main
// process, the renderer and the tests, so the three cannot disagree.

import { hasOwn as has, isScalar, toText } from './text.js';
import { isEditableVarList } from './varsModel.js';

// Match keys the editor reads and writes. Anything else in a match is carried
// through `extras` untouched, so Espanso keys this app does not model
// (left_word, apps, priority and whatever Espanso adds next) are never lost.
export const KNOWN_KEYS = [
	'trigger',
	'triggers',
	'regex',
	'replace',
	'markdown',
	'html',
	'image_path',
	'form',
	'form_fields',
	'label',
	'search_terms',
	'word',
	'propagate_case',
	'uppercase_style',
	'force_mode',
	'vars',
];

export const CONTENT_TYPES = [
	{ id: 'replace', label: 'Plain text' },
	{ id: 'markdown', label: 'Markdown' },
	{ id: 'html', label: 'HTML' },
	{ id: 'form', label: 'Form' },
	{ id: 'image_path', label: 'Image' },
];

export const TRIGGER_MODES = [
	{ id: 'single', label: 'Single' },
	{ id: 'multiple', label: 'Multiple' },
	{ id: 'regex', label: 'Regex' },
];

export const UPPERCASE_STYLES = [
	{ id: '', label: 'Default' },
	{ id: 'capitalize', label: 'Capitalize first letter' },
	{ id: 'capitalize_words', label: 'Capitalize each word' },
	{ id: 'uppercase', label: 'UPPERCASE' },
];

export const FORCE_MODES = [
	{ id: '', label: 'Automatic' },
	{ id: 'clipboard', label: 'Clipboard' },
	{ id: 'keys', label: 'Keystrokes' },
];

// Checked in this order because a match should carry one content key; when a
// hand-edited match carries several, the richer one is what Espanso expands.
const CONTENT_KEYS = ['form', 'markdown', 'html', 'image_path', 'replace'];

export function contentTypeOf(match) {
	return CONTENT_KEYS.find((key) => has(match, key)) ?? 'replace';
}

export function triggerModeOf(match) {
	if (has(match, 'regex')) return 'regex';
	if (Array.isArray(match.triggers)) return 'multiple';
	return 'single';
}

// Everything shown from a match goes through toText: a file can hold any
// shape under any key, and none of it may break a list or the editor.
export function matchTriggers(match) {
	if (typeof match.regex === 'string') return [match.regex];
	const triggers = Array.isArray(match.triggers) ? match.triggers : [match.trigger];
	return triggers.map(toText).filter(Boolean);
}

export function previewText(match, max = 140) {
	const text = toText(match[contentTypeOf(match)])
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

export function emptyDraft({ prefix = '' } = {}) {
	return {
		triggerMode: 'single',
		trigger: prefix,
		triggers: [],
		regex: '',
		label: '',
		searchTerms: [],
		searchTermsRaw: undefined,
		contentType: 'replace',
		content: '',
		formFields: undefined,
		vars: [],
		varsRaw: undefined,
		word: false,
		propagateCase: false,
		uppercaseStyle: '',
		forceMode: '',
		extras: {},
	};
}

export function matchToDraft(match) {
	const draft = emptyDraft();
	draft.triggerMode = triggerModeOf(match);
	draft.trigger = toText(match.trigger);
	draft.triggers = Array.isArray(match.triggers) ? match.triggers.map(toText) : [];
	draft.regex = typeof match.regex === 'string' ? match.regex : '';
	draft.label = toText(match.label);

	// Shapes the form cannot show are carried as they are and written back
	// untouched: search terms that are not a list of text, and variables
	// that are not a list of named mappings.
	if (Array.isArray(match.search_terms) && match.search_terms.every(isScalar)) {
		draft.searchTerms = match.search_terms.map(toText);
	} else if (has(match, 'search_terms')) {
		draft.searchTermsRaw = match.search_terms;
	}

	draft.contentType = contentTypeOf(match);
	draft.content = toText(match[draft.contentType]);
	draft.formFields = match.form_fields;
	if (isEditableVarList(match.vars)) draft.vars = structuredClone(match.vars);
	else if (has(match, 'vars')) draft.varsRaw = match.vars;
	draft.word = match.word === true;
	draft.propagateCase = match.propagate_case === true;
	draft.uppercaseStyle = typeof match.uppercase_style === 'string' ? match.uppercase_style : '';
	draft.forceMode = typeof match.force_mode === 'string' ? match.force_mode : '';

	for (const [key, value] of Object.entries(match)) {
		if (!KNOWN_KEYS.includes(key)) draft.extras[key] = value;
	}
	return draft;
}

// An empty row in a list is a row nobody filled in. Anything else is kept
// exactly as typed: a trailing space in a trigger is part of the trigger.
const filled = (list) => list.map((item) => String(item)).filter((item) => item !== '');

export function draftToMatch(draft) {
	const match = {};

	if (draft.triggerMode === 'regex') {
		match.regex = draft.regex;
	} else if (draft.triggerMode === 'multiple') {
		match.triggers = filled(draft.triggers);
	} else {
		match.trigger = draft.trigger;
	}

	if (draft.label.trim()) match.label = draft.label.trim();

	match[draft.contentType] = draft.content;
	if (draft.contentType === 'form' && draft.formFields && Object.keys(draft.formFields).length) {
		match.form_fields = draft.formFields;
	}

	if (draft.varsRaw !== undefined) match.vars = draft.varsRaw;
	else if (draft.vars.length) match.vars = draft.vars;
	if (draft.word) match.word = true;
	if (draft.propagateCase) match.propagate_case = true;
	if (draft.uppercaseStyle) match.uppercase_style = draft.uppercaseStyle;
	if (draft.forceMode) match.force_mode = draft.forceMode;

	if (draft.searchTermsRaw !== undefined) {
		match.search_terms = draft.searchTermsRaw;
	} else {
		const terms = filled(draft.searchTerms);
		if (terms.length) match.search_terms = terms;
	}

	return { ...match, ...draft.extras };
}

export function validateDraft(draft, { prefix = '' } = {}) {
	const errors = [];

	if (draft.triggerMode === 'regex') {
		// Espanso compiles this with Rust's regex crate, whose syntax differs
		// from JavaScript's (named groups are `(?P<name>…)`), so it is not
		// compiled here: a valid Espanso pattern must not be rejected.
		if (!draft.regex.trim()) errors.push({ field: 'regex', message: 'Add a regex pattern.' });
	} else if (draft.triggerMode === 'multiple') {
		const triggers = filled(draft.triggers);
		if (!triggers.length) {
			errors.push({ field: 'triggers', message: 'Add at least one trigger.' });
		} else if (new Set(triggers).size !== triggers.length) {
			errors.push({ field: 'triggers', message: 'Each trigger can appear only once.' });
		}
	} else if (draft.trigger === '') {
		errors.push({ field: 'trigger', message: 'Add a trigger.' });
	} else if (prefix && draft.trigger === prefix) {
		errors.push({ field: 'trigger', message: `Add the rest of the trigger after "${prefix}".` });
	}

	if (draft.contentType === 'image_path' && !draft.content.trim()) {
		errors.push({ field: 'content', message: 'Add the path to an image.' });
	}
	if (draft.contentType === 'form' && !draft.content.trim()) {
		errors.push({ field: 'content', message: 'Add a form layout, for example "Hi [[name]]".' });
	}

	const seen = new Set();
	draft.vars.forEach((variable, index) => {
		const name = typeof variable?.name === 'string' ? variable.name.trim() : '';
		if (!name) {
			errors.push({ field: `vars.${index}`, message: 'Give this variable a name.' });
		} else if (seen.has(name)) {
			errors.push({ field: `vars.${index}`, message: `Another variable is already named "${name}".` });
		}
		seen.add(name);
	});

	return errors;
}

export function deepEqual(a, b) {
	// NaN is the one value that is not equal to itself.
	if (a === b || (a !== a && b !== b)) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => has(b, key) && deepEqual(a[key], b[key]));
}

// The match to save for an existing snippet: the original with only the
// user's changes applied. Going through the form normalises a few shapes (a
// numeric label becomes text, a second content key is not shown), and none of
// that should reach the file unless the user edited that field.
export function applyDraft(original, draft) {
	const baseline = draftToMatch(matchToDraft(original));
	const edited = draftToMatch(draft);
	const next = { ...original };
	for (const key of Object.keys(baseline)) {
		if (!has(edited, key)) delete next[key];
	}
	for (const [key, value] of Object.entries(edited)) {
		if (!has(baseline, key) || !deepEqual(baseline[key], value)) next[key] = value;
	}
	// The form shows list entries as text. An entry whose text was not edited
	// goes back as it was, so a number stays a number.
	for (const key of ['triggers', 'search_terms']) {
		if (Array.isArray(original[key]) && Array.isArray(next[key]) && next[key] !== original[key]) {
			next[key] = next[key].map((value, index) => (index < original[key].length && toText(original[key][index]) === value ? original[key][index] : value));
		}
	}
	return next;
}
