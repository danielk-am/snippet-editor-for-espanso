import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	VAR_TYPES,
	defaultVar,
	isStructuredVar,
	formFieldNames,
	fieldsToRows,
	rowsToFields,
	isStructuredFields,
} from '../shared/varsModel.js';

test('the editor knows the nine Espanso variable types', () => {
	assert.deepEqual(Object.keys(VAR_TYPES).sort(), [
		'choice',
		'clipboard',
		'date',
		'echo',
		'form',
		'match',
		'random',
		'script',
		'shell',
	]);
});

test('a new variable gets a name no other variable uses', () => {
	const v = defaultVar('date', ['var1', 'var2']);
	assert.equal(v.name, 'var3');
	assert.equal(v.type, 'date');
	assert.deepEqual(v.params, { format: '%Y-%m-%d' });
});

test('a clipboard variable has no params', () => {
	assert.deepEqual(defaultVar('clipboard', []).params, {});
});

test('variables whose params fit the form are structured', () => {
	assert.equal(isStructuredVar({ name: 'd', type: 'date', params: { format: '%Y', offset: 86400 } }), true);
	assert.equal(isStructuredVar({ name: 'c', type: 'clipboard' }), true);
	assert.equal(isStructuredVar({ name: 's', type: 'shell', params: { cmd: 'date', trim: false } }), true);
	assert.equal(isStructuredVar({ name: 'r', type: 'random', params: { choices: ['a', 'b'] } }), true);
});

test('unknown types, unknown params and odd shapes fall back to raw YAML', () => {
	assert.equal(isStructuredVar({ name: 'x', type: 'mystery', params: {} }), false);
	assert.equal(isStructuredVar({ name: 'd', type: 'date', params: { format: '%Y', tz: 'UTC+8' } }), false);
	assert.equal(isStructuredVar({ name: 'd', type: 'date', params: { format: 5 } }), false);
	assert.equal(
		isStructuredVar({ name: 'c', type: 'choice', params: { values: [{ label: 'A', id: 'a' }] } }),
		false
	);
	assert.equal(isStructuredVar({ name: 'c', type: 'choice', params: { values: 'a\nb' } }), false);
});

test('form layout names are read in order without repeats', () => {
	assert.deepEqual(formFieldNames('Meet [[who]] on [[day]] and [[who]] again'), ['who', 'day']);
	assert.deepEqual(formFieldNames(''), []);
});

test('field rows follow the layout, then any extra configured fields', () => {
	const rows = fieldsToRows(
		{ topic: { multiline: true }, day: { type: 'choice', values: ['Mon', 'Wed'] }, old: { default: 'x' } },
		'Meet [[who]] on [[day]] about [[topic]]'
	);
	assert.deepEqual(rows, [
		{ name: 'who', kind: 'text', values: [], default: '' },
		{ name: 'day', kind: 'choice', values: ['Mon', 'Wed'], default: '' },
		{ name: 'topic', kind: 'multiline', values: [], default: '' },
		{ name: 'old', kind: 'text', values: [], default: 'x' },
	]);
});

test('rows write back only what differs from a plain text field', () => {
	const fields = rowsToFields([
		{ name: 'who', kind: 'text', values: [], default: '' },
		{ name: 'day', kind: 'choice', values: ['Mon', 'Wed'], default: '' },
		{ name: 'topic', kind: 'multiline', values: [], default: '' },
		{ name: 'pick', kind: 'list', values: ['a'], default: 'a' },
		{ name: 'old', kind: 'text', values: [], default: 'x' },
	]);
	assert.deepEqual(fields, {
		day: { type: 'choice', values: ['Mon', 'Wed'] },
		topic: { multiline: true },
		pick: { type: 'list', values: ['a'], default: 'a' },
		old: { default: 'x' },
	});
});

test('field shapes the rows cannot express are not structured', () => {
	assert.equal(isStructuredFields({ a: { multiline: true }, b: { type: 'choice', values: ['x'] } }), true);
	assert.equal(isStructuredFields(undefined), true);
	assert.equal(isStructuredFields({ a: { type: 'choice', values: 'x\ny' } }), false);
	assert.equal(isStructuredFields({ a: { type: 'slider' } }), false);
	assert.equal(isStructuredFields({ a: { multiline: true, trim: true } }), false);
	assert.equal(isStructuredFields(['a']), false);
});

test('rows keep blank values while they are being typed', () => {
	const fields = rowsToFields([{ name: 'day', kind: 'choice', values: ['Mon', ''], default: '' }]);
	assert.deepEqual(fields, { day: { type: 'choice', values: ['Mon', ''] } });
});
