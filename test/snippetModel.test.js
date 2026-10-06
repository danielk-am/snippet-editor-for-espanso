import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	contentTypeOf,
	triggerModeOf,
	matchToDraft,
	draftToMatch,
	validateDraft,
	matchTriggers,
	previewText,
	emptyDraft,
} from '../shared/snippetModel.js';

test('a match carrying form is a form snippet', () => {
	assert.equal(contentTypeOf({ trigger: ':m', form: 'Hi [[name]]' }), 'form');
});

test('content type follows the content key present', () => {
	assert.equal(contentTypeOf({ trigger: ':a', markdown: '**a**' }), 'markdown');
	assert.equal(contentTypeOf({ trigger: ':a', html: '<b>a</b>' }), 'html');
	assert.equal(contentTypeOf({ trigger: ':a', image_path: '/x.png' }), 'image_path');
	assert.equal(contentTypeOf({ trigger: ':a', replace: 'a' }), 'replace');
	assert.equal(contentTypeOf({ trigger: ':a' }), 'replace');
});

test('trigger mode reads regex, then a triggers list, then a single trigger', () => {
	assert.equal(triggerModeOf({ regex: ':t(\\d+)', replace: 'x' }), 'regex');
	assert.equal(triggerModeOf({ triggers: [':a', ':b'], replace: 'x' }), 'multiple');
	assert.equal(triggerModeOf({ trigger: ':a', replace: 'x' }), 'single');
});

test('keys the editor does not know survive a round trip untouched', () => {
	const match = { trigger: ':sig', replace: 'Best,\nDaniel', left_word: true, priority: 3 };
	const draft = matchToDraft(match);
	assert.deepEqual(draft.extras, { left_word: true, priority: 3 });
	assert.deepEqual(draftToMatch(draft), match);
});

test('every known key survives a round trip', () => {
	const match = {
		trigger: ':shrug',
		label: 'Shrug',
		replace: 'x',
		vars: [{ name: 'd', type: 'date', params: { format: '%Y' } }],
		word: true,
		propagate_case: true,
		uppercase_style: 'capitalize_words',
		force_mode: 'clipboard',
		search_terms: ['a', 'b'],
	};
	assert.deepEqual(draftToMatch(matchToDraft(match)), match);
});

test('false flags and default styles are left out of the written match', () => {
	const draft = matchToDraft({ trigger: ':a', replace: 'x' });
	draft.word = false;
	draft.propagateCase = false;
	draft.uppercaseStyle = '';
	draft.forceMode = '';
	assert.deepEqual(draftToMatch(draft), { trigger: ':a', replace: 'x' });
});

test('turning word on writes word: true', () => {
	const draft = matchToDraft({ trigger: ':a', replace: 'x' });
	draft.word = true;
	assert.deepEqual(draftToMatch(draft), { trigger: ':a', replace: 'x', word: true });
});

test('multiple mode writes triggers and drops trigger', () => {
	const draft = matchToDraft({ trigger: ':a', replace: 'x' });
	draft.triggerMode = 'multiple';
	draft.triggers = [':a', ':b'];
	assert.deepEqual(draftToMatch(draft), { triggers: [':a', ':b'], replace: 'x' });
});

test('multiple mode stays a list when one trigger is left, and drops empty rows', () => {
	const draft = matchToDraft({ triggers: [':a', ':b'], replace: 'x' });
	draft.triggers = [':a', ''];
	assert.deepEqual(draftToMatch(draft), { triggers: [':a'], replace: 'x' });
});

test('editing the only trigger of a one-item list changes that list', () => {
	const original = { triggers: [':a'], replace: 'x' };
	const draft = matchToDraft(original);
	draft.triggers = [':b'];
	assert.deepEqual(applyDraft(original, draft), { triggers: [':b'], replace: 'x' });
});

test('adding a trigger or search term leaves the others exactly as they were', () => {
	const original = { triggers: ['teh ', 'hte '], replace: 'the ', search_terms: [2024, ' padded '] };
	const draft = matchToDraft(original);
	draft.triggers = [...draft.triggers, 'eht '];
	draft.searchTerms = [...draft.searchTerms, 'new'];
	assert.deepStrictEqual(applyDraft(original, draft), {
		triggers: ['teh ', 'hte ', 'eht '],
		replace: 'the ',
		search_terms: [2024, ' padded ', 'new'],
	});
});

test('editing one variable leaves the lists of the others exactly as they were', () => {
	const original = {
		trigger: ':t',
		replace: '{{c}} {{e}}',
		vars: [
			{ name: 'c', type: 'choice', params: { values: ['', 'Mr', 'Ms'] } },
			{ name: 'e', type: 'echo', params: { echo: 'x' } },
		],
	};
	const draft = matchToDraft(original);
	draft.vars[1].name = 'renamed';
	const saved = applyDraft(original, draft);
	assert.deepEqual(saved.vars[0], original.vars[0]);
	assert.equal(saved.vars[1].name, 'renamed');
});

test('regex mode writes regex only', () => {
	const draft = matchToDraft({ trigger: ':a', replace: 'x' });
	draft.triggerMode = 'regex';
	draft.regex = ':t(?P<n>\\d+)';
	assert.deepEqual(draftToMatch(draft), { regex: ':t(?P<n>\\d+)', replace: 'x' });
});

test('changing content type moves the content to the new key', () => {
	const draft = matchToDraft({ trigger: ':a', replace: '**bold**' });
	draft.contentType = 'markdown';
	assert.deepEqual(draftToMatch(draft), { trigger: ':a', markdown: '**bold**' });
});

test('form_fields are written for form snippets and dropped otherwise', () => {
	const match = {
		trigger: ':m',
		form: 'Meet [[who]]',
		form_fields: { who: { multiline: true } },
	};
	const draft = matchToDraft(match);
	assert.deepEqual(draftToMatch(draft), match);
	draft.contentType = 'replace';
	assert.deepEqual(draftToMatch(draft), { trigger: ':m', replace: 'Meet [[who]]' });
});

test('a search_terms value that is not a list is preserved as it was', () => {
	const match = { trigger: ':a', replace: 'x', search_terms: 'hello' };
	const draft = matchToDraft(match);
	assert.equal(draft.searchTermsRaw, 'hello');
	assert.deepEqual(draftToMatch(draft), match);
});

test('blank search terms are dropped and an empty list is not written', () => {
	const draft = matchToDraft({ trigger: ':a', replace: 'x', search_terms: ['one'] });
	draft.searchTerms = ['', ''];
	assert.deepEqual(draftToMatch(draft), { trigger: ':a', replace: 'x' });
});

test('an empty replace is still written, because Espanso needs a content key', () => {
	const draft = emptyDraft();
	draft.trigger = ':gone';
	assert.deepEqual(draftToMatch(draft), { trigger: ':gone', replace: '' });
});

test('a new draft starts with the file prefix as its trigger', () => {
	assert.equal(emptyDraft({ prefix: ';' }).trigger, ';');
	assert.equal(emptyDraft().trigger, '');
});

test('validation names a missing trigger', () => {
	const draft = emptyDraft();
	assert.deepEqual(validateDraft(draft), [{ field: 'trigger', message: 'Add a trigger.' }]);
});

test('validation rejects a trigger that is only the file prefix', () => {
	const draft = emptyDraft({ prefix: ';' });
	const errors = validateDraft(draft, { prefix: ';' });
	assert.equal(errors.length, 1);
	assert.equal(errors[0].field, 'trigger');
});

test('validation rejects duplicate triggers in multiple mode', () => {
	const draft = matchToDraft({ triggers: [':a', ':a'], replace: 'x' });
	assert.deepEqual(
		validateDraft(draft).map((e) => e.field),
		['triggers']
	);
});

test('validation does not reject Rust-only regex syntax such as named groups', () => {
	const draft = matchToDraft({ regex: ':t(?P<id>\\d+)', replace: 'x' });
	assert.deepEqual(validateDraft(draft), []);
});

test('validation requires an image path and a form layout', () => {
	const image = matchToDraft({ trigger: ':i', image_path: '' });
	assert.deepEqual(
		validateDraft(image).map((e) => e.field),
		['content']
	);
	const form = matchToDraft({ trigger: ':f', form: '' });
	assert.deepEqual(
		validateDraft(form).map((e) => e.field),
		['content']
	);
});

test('validation rejects variables without a name or with a repeated name', () => {
	const draft = matchToDraft({
		trigger: ':a',
		replace: 'x',
		vars: [
			{ name: '', type: 'date', params: {} },
			{ name: 'n', type: 'echo', params: { echo: 'a' } },
			{ name: 'n', type: 'echo', params: { echo: 'b' } },
		],
	});
	assert.deepEqual(
		validateDraft(draft).map((e) => e.field),
		['vars.0', 'vars.2']
	);
});

test('matchTriggers lists every way a match can fire', () => {
	assert.deepEqual(matchTriggers({ trigger: ':a' }), [':a']);
	assert.deepEqual(matchTriggers({ triggers: [':a', ':b'] }), [':a', ':b']);
	assert.deepEqual(matchTriggers({ regex: ':t\\d' }), [':t\\d']);
	assert.deepEqual(matchTriggers({}), []);
});

test('previewText flattens whitespace and truncates long content', () => {
	assert.equal(previewText({ replace: 'Best,\n  Daniel' }), 'Best, Daniel');
	const long = 'a'.repeat(300);
	const out = previewText({ replace: long }, 20);
	assert.equal(out, 'a'.repeat(19) + '…');
});

// --- applyDraft: saving must not rewrite what the user did not touch ---------

import { applyDraft, deepEqual } from '../shared/snippetModel.js';

test('saving an untouched draft gives back the original match exactly', () => {
	const original = { trigger: ':a', label: 123, replace: 'x', markdown: '**x**', triggers: 'odd', left_word: true };
	assert.deepEqual(applyDraft(original, matchToDraft(original)), original);
});

test('editing one field leaves the type and value of the others alone', () => {
	const original = { trigger: ':a', label: 123, replace: 'x', search_terms: 'raw' };
	const draft = matchToDraft(original);
	draft.content = 'y';
	assert.deepStrictEqual(applyDraft(original, draft), { trigger: ':a', label: 123, replace: 'y', search_terms: 'raw' });
});

test('a second content key the editor does not show is kept on save', () => {
	const original = { trigger: ':a', markdown: '**x**', replace: 'x' };
	const draft = matchToDraft(original);
	draft.label = 'Both';
	assert.deepEqual(applyDraft(original, draft), { trigger: ':a', markdown: '**x**', replace: 'x', label: 'Both' });
});

test('switching content type removes the old content key', () => {
	const original = { trigger: ':a', replace: 'x' };
	const draft = matchToDraft(original);
	draft.contentType = 'html';
	draft.content = '<b>x</b>';
	assert.deepEqual(applyDraft(original, draft), { trigger: ':a', html: '<b>x</b>' });
});

test('clearing a field removes its key', () => {
	const original = { trigger: ':a', label: 'L', replace: 'x', word: true };
	const draft = matchToDraft(original);
	draft.label = '';
	draft.word = false;
	assert.deepEqual(applyDraft(original, draft), { trigger: ':a', replace: 'x' });
});

test('deepEqual compares nested values and tells types apart', () => {
	assert.equal(deepEqual({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] }), true);
	assert.equal(deepEqual({ a: 1 }, { a: '1' }), false);
	assert.equal(deepEqual([1, 2], [1, 2, 3]), false);
	assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false);
	assert.equal(deepEqual(null, {}), false);
});
