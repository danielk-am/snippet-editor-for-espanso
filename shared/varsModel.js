// Espanso variables and form fields, as the structured editor understands
// them. A shape the editor cannot express is edited as raw YAML instead, so
// nothing is rewritten into a form that loses detail.

import { hasOwn, isPlainObject } from './text.js';

const isString = (value) => typeof value === 'string';
const isStringList = (value) => Array.isArray(value) && value.every(isString);

// Each param names the check its value must pass to be edited in a field.
export const VAR_TYPES = {
	date: {
		label: 'Date',
		help: 'The current date or time, formatted with strftime codes.',
		params: { format: 'string', offset: 'number', locale: 'string' },
		defaults: { format: '%Y-%m-%d' },
	},
	clipboard: {
		label: 'Clipboard',
		help: 'Whatever is on the clipboard when the snippet expands.',
		params: {},
		defaults: {},
	},
	echo: {
		label: 'Fixed text',
		help: 'A fixed value, useful as a named constant.',
		params: { echo: 'string' },
		defaults: { echo: '' },
	},
	shell: {
		label: 'Shell command',
		help: 'The output of a shell command.',
		params: { cmd: 'string', shell: 'string', trim: 'boolean', debug: 'boolean' },
		defaults: { cmd: '' },
	},
	script: {
		label: 'Script',
		help: 'The output of a program, given as its arguments.',
		params: { args: 'list', trim: 'boolean', debug: 'boolean' },
		defaults: { args: [] },
	},
	random: {
		label: 'Random choice',
		help: 'One of these values, picked at random.',
		params: { choices: 'list' },
		defaults: { choices: [] },
	},
	choice: {
		label: 'Choice',
		help: 'Asks you to pick one of these values.',
		params: { values: 'list' },
		defaults: { values: [] },
	},
	form: {
		label: 'Form',
		help: 'Asks for several values in one dialog.',
		params: { layout: 'string', fields: 'fields' },
		defaults: { layout: '' },
	},
	match: {
		label: 'Another snippet',
		help: 'The expansion of another snippet, named by its trigger.',
		params: { trigger: 'string' },
		defaults: { trigger: '' },
	},
};

const PARAM_CHECKS = {
	string: isString,
	number: (value) => typeof value === 'number' && Number.isFinite(value),
	boolean: (value) => typeof value === 'boolean',
	list: isStringList,
	fields: (value) => isStructuredFields(value),
};

// Looked up by own key only: a type or param named `constructor` in a file
// must not resolve to something inherited from Object.
export const varSpec = (type) => (isString(type) && hasOwn(VAR_TYPES, type) ? VAR_TYPES[type] : undefined);

export function defaultVar(type, existingNames = []) {
	let n = 1;
	while (existingNames.includes(`var${n}`)) n += 1;
	return { name: `var${n}`, type, params: structuredClone(varSpec(type)?.defaults ?? {}) };
}

export function isStructuredVar(variable) {
	const spec = varSpec(variable?.type);
	if (!spec) return false;
	const params = variable.params ?? {};
	if (!isPlainObject(params)) return false;
	return Object.entries(params).every(([key, value]) => hasOwn(spec.params, key) && PARAM_CHECKS[spec.params[key]](value));
}

// The variable form edits a list of mappings with text names and types. Any
// other shape is shown whole as YAML instead.
export function isEditableVarList(vars) {
	return (
		Array.isArray(vars) &&
		vars.every(
			(variable) =>
				isPlainObject(variable) &&
				(variable.name === undefined || isString(variable.name)) &&
				(variable.type === undefined || isString(variable.type))
		)
	);
}

export const FIELD_KINDS = [
	{ id: 'text', label: 'Text' },
	{ id: 'multiline', label: 'Long text' },
	{ id: 'choice', label: 'Dropdown' },
	{ id: 'list', label: 'List' },
];

export function formFieldNames(layout) {
	const names = [];
	for (const [, name] of String(layout ?? '').matchAll(/\[\[\s*([^\]\s]+)\s*\]\]/g)) {
		if (!names.includes(name)) names.push(name);
	}
	return names;
}

function fieldKind(field) {
	if (field?.type === 'choice' || field?.type === 'list') return field.type;
	return field?.multiline === true ? 'multiline' : 'text';
}

export function fieldsToRows(fields, layout) {
	const configured = isPlainObject(fields) ? fields : {};
	const names = formFieldNames(layout);
	for (const name of Object.keys(configured)) {
		if (!names.includes(name)) names.push(name);
	}
	return names.map((name) => {
		const field = hasOwn(configured, name) && isPlainObject(configured[name]) ? configured[name] : {};
		return {
			name,
			kind: fieldKind(field),
			values: isStringList(field.values) ? [...field.values] : [],
			default: isString(field.default) ? field.default : '',
		};
	});
}

export function rowsToFields(rows) {
	const entries = [];
	for (const row of rows) {
		const field = {};
		if (row.kind === 'multiline') field.multiline = true;
		if (row.kind === 'choice' || row.kind === 'list') {
			field.type = row.kind;
			field.values = [...row.values];
		}
		if (row.default) field.default = row.default;
		if (Object.keys(field).length) entries.push([row.name, field]);
	}
	// fromEntries defines each name as an own key, so a field called
	// __proto__ stays a field.
	return Object.fromEntries(entries);
}

const FIELD_KEYS = {
	text: ['default'],
	multiline: ['multiline', 'default'],
	choice: ['type', 'values', 'default'],
	list: ['type', 'values', 'default'],
};

export function isStructuredFields(fields) {
	if (fields === undefined || fields === null) return true;
	if (!isPlainObject(fields)) return false;
	return Object.values(fields).every((field) => {
		if (!isPlainObject(field)) return false;
		if (field.type !== undefined && field.type !== 'choice' && field.type !== 'list') return false;
		if (field.multiline !== undefined && field.multiline !== true) return false;
		if (field.values !== undefined && !isStringList(field.values)) return false;
		if (field.default !== undefined && !isString(field.default)) return false;
		const allowed = FIELD_KEYS[fieldKind(field)];
		return Object.keys(field).every((key) => allowed.includes(key));
	});
}
