import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGit } from '../core/git.js';
import { createApiClient } from '../mcp/client.mjs';
import { createTools } from '../mcp/tools.mjs';
import { startApi } from './helpers/apiFixture.js';
import { MANIFEST, gitEnv, seeded } from './helpers/teamRemote.js';

async function setup(t, options = {}) {
	const api = await startApi(t, options);
	const tools = createTools({ api: createApiClient({ dataDir: api.dataDir }) });
	// A successful call's data, or its error text.
	const call = async (name, args = {}) => {
		const result = await tools.call(name, args);
		assert.ok(result, `unknown tool ${name}`);
		assert.deepEqual(Object.keys(result).sort(), result.isError ? ['content', 'isError'] : ['content', 'isError', 'structuredContent']);
		assert.deepEqual(result.content.map((item) => item.type), ['text']);
		if (result.isError) return { error: result.content[0].text };
		assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
		return result.structuredContent;
	};
	const read = (name) => readFileSync(join(api.matchDir, name), 'utf8');
	const version = async (fileId) => (await call('snippets_get_file', { file_id: fileId })).version;
	return { ...api, tools, call, read, version };
}

const WRITE_TOOLS = ['snippets_add_snippet', 'snippets_update_snippet', 'snippets_delete_snippet', 'snippets_create_file', 'snippets_replace_file_yaml', 'snippets_install_team_package', 'snippets_propose_to_team'];
const READ_TOOLS = ['snippets_search', 'snippets_list_files', 'snippets_get_file', 'snippets_get_snippet', 'snippets_list_team_packages'];

// --- the list of tools -----------------------------------------------------------------

test('twelve tools are listed, read tools first, each described for a model and marked for what it does', async (t) => {
	const { tools } = await setup(t);
	const listed = tools.list();
	assert.deepEqual(listed.map((tool) => tool.name), [...READ_TOOLS, ...WRITE_TOOLS]);
	for (const tool of listed) {
		assert.deepEqual(Object.keys(tool).sort(), ['annotations', 'description', 'inputSchema', 'name', 'title'], tool.name);
		assert.match(tool.name, /^snippets_[a-z_]+$/);
		assert.ok(tool.description.length >= 80, `${tool.name} needs a fuller description`);
		assert.deepEqual([tool.inputSchema.type, tool.inputSchema.additionalProperties], ['object', false], tool.name);
		for (const [key, property] of Object.entries(tool.inputSchema.properties ?? {})) assert.ok(property.description, `${tool.name}.${key} needs a description`);
		assert.equal(tool.annotations.readOnlyHint, READ_TOOLS.includes(tool.name), tool.name);
	}
	const hints = Object.fromEntries(listed.map((tool) => [tool.name, tool.annotations]));
	assert.equal(hints.snippets_delete_snippet.destructiveHint, true);
	assert.equal(hints.snippets_replace_file_yaml.destructiveHint, true);
	assert.equal(hints.snippets_add_snippet.destructiveHint, false);
	assert.equal(hints.snippets_propose_to_team.openWorldHint, true);
	assert.equal(hints.snippets_search.openWorldHint, false);
	// The same list every time, whatever the switch says.
	assert.deepEqual(tools.list(), listed);
	assert.equal(await tools.call('no_such_tool', {}), null);
});

// --- reading ---------------------------------------------------------------------------

test('snippets_search finds snippets across files and packages, with names beside ids', async (t) => {
	const { call } = await setup(t);
	assert.deepEqual(await call('snippets_search', { query: 'goodbye' }), {
		items: [{ file_id: 'package:goodbyes:package.yml', file: 'package.yml', source: 'package', package: 'goodbyes', index: 0, triggers: [':bye'], label: 'Friendly goodbye', preview: 'Thanks for reaching out. Have a great day!' }],
		total_count: 1,
		has_more: false,
		next_offset: null,
	});
	const thanks = await call('snippets_search', { query: 'thank' });
	assert.deepEqual(thanks.items.map((item) => [item.file_id, item.index, item.triggers]), [
		['local:base.yml', 2, [';ty', ';thanks']],
		['package:goodbyes:package.yml', 0, [':bye']],
	]);
	assert.deepEqual(await call('snippets_search', { query: 'zzz-nothing' }), {
		items: [],
		total_count: 0,
		has_more: false,
		next_offset: null,
		note: 'No snippets match. Try fewer or different words: search looks at triggers, labels, search terms and the text a snippet expands to.',
	});
});

test('lists are paged: a limit, a total, whether there is more, and where to go on from', async (t) => {
	const { call } = await setup(t);
	const first = await call('snippets_search', { query: 'e', limit: 3 });
	assert.deepEqual([first.items.length, first.has_more, first.next_offset], [3, true, 3]);
	const rest = await call('snippets_search', { query: 'e', limit: 200, offset: 3 });
	assert.equal(first.total_count, 3 + rest.items.length);
	assert.deepEqual([rest.has_more, rest.next_offset], [false, null]);
	assert.deepEqual((await call('snippets_search', { query: 'e', offset: 999 })).items, []);
});

test('snippets_list_files lists every file with its source and any problem, and can keep to one source', async (t) => {
	const { call } = await setup(t);
	const all = await call('snippets_list_files');
	assert.equal(all.total_count, 5);
	assert.deepEqual(all.items.map((item) => item.file_id), ['local:_shared.yml', 'local:base.yml', 'local:broken.yml', 'local:dates.yml', 'package:goodbyes:package.yml']);
	assert.deepEqual(all.items[1], { file_id: 'local:base.yml', name: 'base.yml', source: 'local', description: 'Greetings for support replies', prefix: ';', snippet_count: 3, read_only: false });
	assert.deepEqual([all.items[2].snippet_count, typeof all.items[2].problem], [null, 'string']);
	assert.deepEqual(all.items[4], { file_id: 'package:goodbyes:package.yml', name: 'package.yml', source: 'package', package: 'goodbyes', description: '', prefix: '', snippet_count: 2, read_only: true });
	assert.deepEqual((await call('snippets_list_files', { source: 'package' })).items.map((item) => item.file_id), ['package:goodbyes:package.yml']);
	assert.deepEqual((await call('snippets_list_files', { source: 'team' })).items, []);
});

test('snippets_get_file gives a file in brief, in full or as raw YAML, always with its version', async (t) => {
	const { call, read } = await setup(t);
	const brief = await call('snippets_get_file', { file_id: 'local:base.yml' });
	assert.match(brief.version, /^[a-f0-9]{24}$/);
	assert.deepEqual({ ...brief, version: 'v' }, {
		file_id: 'local:base.yml',
		name: 'base.yml',
		source: 'local',
		description: 'Greetings for support replies',
		prefix: ';',
		read_only: false,
		version: 'v',
		snippet_count: 3,
		snippets: [
			{ index: 0, triggers: [';hello'], label: '', preview: 'Hello there' },
			{ index: 1, triggers: [';sig'], label: 'Signature', preview: 'Best,\n{{firstname}}' },
			{ index: 2, triggers: [';ty', ';thanks'], label: '', preview: 'Thank you!' },
		],
		has_more: false,
		next_offset: null,
	});
	const full = await call('snippets_get_file', { file_id: 'local:base.yml', detail: 'full', offset: 1, limit: 1 });
	assert.deepEqual([full.snippets, full.has_more, full.next_offset], [[{ index: 1, snippet: { trigger: ';sig', label: 'Signature', replace: 'Best,\n{{firstname}}', left_word: true } }], true, 2]);
	const raw = await call('snippets_get_file', { file_id: 'local:base.yml', detail: 'raw' });
	assert.deepEqual([raw.yaml, raw.version, raw.snippets], [read('base.yml'), brief.version, undefined]);
	// A file that fits is whole, and says so by having nothing more to read.
	assert.deepEqual([raw.has_more, raw.next_offset, raw.total_characters, raw.note], [false, null, read('base.yml').length, undefined]);
});

test('a file with YAML errors is described, and its raw text can still be read', async (t) => {
	const { call, read } = await setup(t);
	const brief = await call('snippets_get_file', { file_id: 'local:broken.yml' });
	assert.deepEqual([brief.snippet_count, brief.snippets], [null, []]);
	assert.match(brief.problem, /YAML errors.*detail "raw"/s);
	assert.equal((await call('snippets_get_file', { file_id: 'local:broken.yml', detail: 'raw' })).yaml, read('broken.yml'));
});

test('snippets_get_snippet gives one snippet in full with its file\'s version', async (t) => {
	const { call, version } = await setup(t);
	assert.deepEqual(await call('snippets_get_snippet', { file_id: 'local:dates.yml', index: 0 }), {
		file_id: 'local:dates.yml',
		file: 'dates.yml',
		read_only: false,
		version: await version('local:dates.yml'),
		index: 0,
		snippet: { trigger: ':today', label: "Today's date", replace: '{{today}}', vars: [{ name: 'today', type: 'date', params: { format: '%d %B %Y' } }] },
	});
	assert.deepEqual(await call('snippets_get_snippet', { file_id: 'local:dates.yml', index: 9 }), { error: 'dates.yml has 4 snippets, at positions 0 to 3. Call snippets_get_file to see them.' });
	assert.match((await call('snippets_get_snippet', { file_id: 'local:broken.yml', index: 0 })).error, /YAML errors/);
});

test('what does not exist is explained, with the tool that lists what does', async (t) => {
	const { call } = await setup(t);
	assert.deepEqual(await call('snippets_get_file', { file_id: 'local:missing.yml' }), { error: 'missing.yml is no longer in the match folder. Call snippets_list_files to see the files and their ids.' });
	assert.deepEqual(await call('snippets_get_file', { file_id: 'nonsense' }), { error: 'That is not a file id. Call snippets_list_files to see the files and their ids.' });
});

test('every input is checked before the app is asked, and the reply names the input', async (t) => {
	const { call } = await setup(t);
	const cases = [
		['snippets_search', {}, /^Missing `query`\./],
		['snippets_search', { query: 5 }, /^`query` must be text\./],
		['snippets_search', { query: '' }, /^`query` must not be empty\./],
		['snippets_search', { query: 'a', limit: 0 }, /^`limit` must be a whole number from 1 to 200\./],
		['snippets_search', { query: 'a', limit: 201 }, /^`limit` must be a whole number from 1 to 200\./],
		['snippets_search', { query: 'a', limit: 2.5 }, /^`limit` must be a whole number from 1 to 200\./],
		['snippets_search', { query: 'a', offset: -1 }, /^`offset` must be a whole number, 0 or more\./],
		['snippets_search', { query: 'a', page: 2 }, /^Unknown input `page`\. This tool takes: query, limit, offset\./],
		['snippets_list_files', { source: 'remote' }, /^`source` must be one of: local, package, team\./],
		['snippets_get_file', { file_id: 'local:base.yml', detail: 'everything' }, /^`detail` must be one of: summary, full, raw\./],
		['snippets_get_snippet', { file_id: 'local:base.yml' }, /^Missing `index`\./],
		['snippets_get_snippet', { file_id: 'local:base.yml', index: '0' }, /^`index` must be a whole number, 0 or more\./],
		['snippets_add_snippet', { file_id: 'local:base.yml', version: 'v', snippet: 'text' }, /^`snippet` must be an object of Espanso keys/],
		['snippets_install_team_package', { name: 'goodbyes', accept_commands: 'yes' }, /^`accept_commands` must be true or false\./],
	];
	for (const [name, args, pattern] of cases) assert.match((await call(name, args)).error, pattern, `${name} ${JSON.stringify(args)}`);
});

// --- changing --------------------------------------------------------------------------

test('with the switch off, every write tool refuses before the app is asked, and nothing changes', async (t) => {
	const { call, read, matchDir } = await setup(t, { aiWrite: false });
	const before = read('base.yml');
	const v = await (async () => (await call('snippets_get_file', { file_id: 'local:base.yml' })).version)();
	const attempts = {
		snippets_add_snippet: { file_id: 'local:base.yml', snippet: { trigger: ';x', replace: 'X' }, version: v },
		snippets_update_snippet: { file_id: 'local:base.yml', index: 0, snippet: { trigger: ';hello', replace: 'Changed' }, version: v },
		snippets_delete_snippet: { file_id: 'local:base.yml', index: 0, version: v },
		snippets_create_file: { name: 'new.yml' },
		snippets_replace_file_yaml: { file_id: 'local:base.yml', yaml: 'matches: []\n', version: v },
		snippets_install_team_package: { name: 'goodbyes' },
		snippets_propose_to_team: { file_id: 'local:base.yml', package: 'goodbyes', summary: 'Share' },
	};
	assert.deepEqual(Object.keys(attempts), WRITE_TOOLS);
	for (const [name, args] of Object.entries(attempts)) {
		assert.deepEqual(await call(name, args), { error: 'Changing snippets is switched off. Ask the person to switch on "Let AI tools change snippets" in Snippet Editor\'s Settings, then try again.' }, name);
	}
	assert.equal(read('base.yml'), before);
	assert.throws(() => readFileSync(join(matchDir, 'new.yml')));
});

test('the switch takes effect at once, with no restart', async (t) => {
	const { call, service, version } = await setup(t, { aiWrite: false });
	const args = async () => ({ file_id: 'local:base.yml', snippet: { trigger: ';x', replace: 'X' }, version: await version('local:base.yml') });
	assert.match((await call('snippets_add_snippet', await args())).error, /switched off/);
	await service.saveSettings({ aiWrite: true });
	assert.equal((await call('snippets_add_snippet', await args())).snippet_count, 4);
	await service.saveSettings({ aiWrite: false });
	assert.match((await call('snippets_add_snippet', await args())).error, /switched off/);
});

test('adding, changing and deleting a snippet each need the version, and give back the new one', async (t) => {
	const { call, read, version } = await setup(t, { aiWrite: true });
	const before = read('base.yml');
	const v1 = await version('local:base.yml');

	const added = await call('snippets_add_snippet', { file_id: 'local:base.yml', snippet: { trigger: ';new', replace: 'New' }, version: v1 });
	assert.deepEqual({ ...added, version: 'v' }, { file_id: 'local:base.yml', index: 3, snippet_count: 4, version: 'v' });
	assert.notEqual(added.version, v1);
	assert.equal(read('base.yml'), `${before}\n  - trigger: ";new"\n    replace: "New"\n`);

	const placed = await call('snippets_add_snippet', { file_id: 'local:base.yml', snippet: { trigger: ';first', replace: '1' }, index: 0, version: added.version });
	assert.deepEqual([placed.index, placed.snippet_count], [0, 5]);

	const changed = await call('snippets_update_snippet', { file_id: 'local:base.yml', index: 1, snippet: { trigger: ';hello', replace: 'Hello again' }, version: placed.version });
	assert.deepEqual([changed.file_id, changed.index], ['local:base.yml', 1]);
	assert.ok(read('base.yml').includes('replace: "Hello again"'));

	const removed = await call('snippets_delete_snippet', { file_id: 'local:base.yml', index: 0, version: changed.version });
	assert.deepEqual([removed.deleted_index, removed.snippet_count], [0, 4]);
	assert.equal((await call('snippets_get_snippet', { file_id: 'local:base.yml', index: 0 })).snippet.replace, 'Hello again');
});

test('a change made on an old version is refused, and says how to carry on', async (t) => {
	const { call, read, version } = await setup(t, { aiWrite: true });
	const stale = await version('local:base.yml');
	await call('snippets_add_snippet', { file_id: 'local:base.yml', snippet: { trigger: ';one', replace: '1' }, version: stale });
	const after = read('base.yml');
	const expected = { error: 'base.yml changed since you read it. Call snippets_get_file for local:base.yml again, look at what changed, then retry with the new version.' };
	assert.deepEqual(await call('snippets_add_snippet', { file_id: 'local:base.yml', snippet: { trigger: ';two', replace: '2' }, version: stale }), expected);
	assert.deepEqual(await call('snippets_update_snippet', { file_id: 'local:base.yml', index: 0, snippet: { trigger: ';hello', replace: 'x' }, version: stale }), expected);
	assert.deepEqual(await call('snippets_delete_snippet', { file_id: 'local:base.yml', index: 0, version: 'made-up' }), expected);
	assert.deepEqual(await call('snippets_replace_file_yaml', { file_id: 'local:base.yml', yaml: 'matches: []\n', version: stale }), expected);
	assert.equal(read('base.yml'), after);
});

test('a package file cannot be changed, and the reply says what to do instead', async (t) => {
	const { call, version } = await setup(t, { aiWrite: true });
	const v = await version('package:goodbyes:package.yml');
	assert.deepEqual(await call('snippets_update_snippet', { file_id: 'package:goodbyes:package.yml', index: 0, snippet: { trigger: ':bye', replace: 'x' }, version: v }), {
		error: 'package.yml is read-only: it belongs to a package, a team package, or is write-protected. To change a snippet from it, add your own copy to one of the person\'s files with snippets_add_snippet.',
	});
});

test('creating a file and replacing a file\'s YAML', async (t) => {
	const { call, read } = await setup(t, { aiWrite: true });
	const created = await call('snippets_create_file', { name: 'work.yml', description: 'Work replies', prefix: ':' });
	assert.deepEqual({ ...created, version: 'v' }, { file_id: 'local:work.yml', name: 'work.yml', version: 'v' });
	assert.equal(read('work.yml'), '# Work replies\n# prefix: ":"\n\nmatches: []\n');
	assert.deepEqual(await call('snippets_create_file', { name: 'work.yml' }), { error: 'A file named work.yml already exists. Choose another name, or change the existing file.' });
	assert.match((await call('snippets_create_file', { name: '../escape.yml' })).error, /file name ending in \.yml/);

	const yaml = '# Work replies\n\nglobal_vars:\n  - name: me\n    type: echo\n    params:\n      echo: Sam\n\nmatches:\n  - trigger: ":me"\n    replace: "{{me}}"\n';
	const replaced = await call('snippets_replace_file_yaml', { file_id: 'local:work.yml', yaml, version: created.version });
	assert.deepEqual([replaced.file_id, replaced.snippet_count], ['local:work.yml', 1]);
	assert.equal(read('work.yml'), yaml);
	const broken = await call('snippets_replace_file_yaml', { file_id: 'local:work.yml', yaml: 'matches:\n  - trigger: "open\n', version: replaced.version });
	assert.match(broken.error, /^That YAML has errors, so nothing was saved: /);
	assert.equal(read('work.yml'), yaml);
});

// --- size ------------------------------------------------------------------------------

test('a reply is never longer than 25,000 characters: a list is cut at a whole item and says where to go on', async (t) => {
	const { call, matchDir } = await setup(t);
	const many = Array.from({ length: 400 }, (_, index) => `  - trigger: ":big${index}"\n    replace: "${'word '.repeat(40)}${index}"\n`).join('');
	writeFileSync(join(matchDir, 'big.yml'), `matches:\n${many}`);

	const full = await call('snippets_get_file', { file_id: 'local:big.yml', detail: 'full', limit: 200 });
	assert.ok(JSON.stringify(full).length <= 25000);
	assert.ok(full.snippets.length > 10 && full.snippets.length < 200);
	assert.deepEqual([full.has_more, full.next_offset, full.snippet_count], [true, full.snippets.length, 400]);
	assert.equal(full.note, `Cut to fit: this reply holds ${full.snippets.length} of the 200 asked for. Ask again with offset ${full.snippets.length}, or use a smaller limit.`);
	const next = await call('snippets_get_file', { file_id: 'local:big.yml', detail: 'full', limit: 200, offset: full.next_offset });
	assert.equal(next.snippets[0].index, full.snippets.length);

	// Raw text comes in parts. Only the last part carries the version, so the
	// whole text has been read before anything can be written back.
	const text = readFileSync(join(matchDir, 'big.yml'), 'utf8');
	const parts = [];
	for (let offset = 0, guard = 0; offset !== null && guard < 50; guard += 1) {
		const part = await call('snippets_get_file', { file_id: 'local:big.yml', detail: 'raw', offset });
		assert.ok(JSON.stringify(part).length <= 25000);
		assert.equal(part.total_characters, text.length);
		assert.equal('version' in part, !part.has_more, `part at ${offset}`);
		assert.match(part.note, new RegExp(`^This is characters ${offset} to \\d+ of ${text.length}\\. `));
		assert.match(part.note, /Join every part, in order, before sending the file back with snippets_replace_file_yaml\.$/);
		parts.push(part.yaml);
		offset = part.next_offset;
	}
	assert.ok(parts.length > 3);
	assert.equal(parts.join(''), text);

	const found = await call('snippets_search', { query: 'word', limit: 200 });
	assert.ok(JSON.stringify(found).length <= 25000);
	assert.deepEqual([found.has_more, found.total_count], [true, 400]);
});

// --- team ------------------------------------------------------------------------------

test('team tools, with no repository connected', async (t) => {
	const { call } = await setup(t, { aiWrite: true });
	assert.deepEqual(await call('snippets_list_team_packages'), {
		connected: false,
		repository: null,
		packages: [],
		total_count: 0,
		has_more: false,
		next_offset: null,
		installed_only: [],
		note: 'No team repository is connected. The person can connect one in the app, under Settings.',
	});
	const expected = { error: 'No team repository is connected. Ask the person to connect one in the app, under Settings.' };
	assert.deepEqual(await call('snippets_install_team_package', { name: 'goodbyes' }), expected);
	assert.deepEqual(await call('snippets_propose_to_team', { file_id: 'local:dates.yml', package: 'goodbyes', summary: 'Share' }), expected);
});

test('team tools, with a repository: list, install, accept commands, propose', async (t) => {
	const remote = seeded();
	remote.commit({
		'packages/tools/_manifest.yml': MANIFEST('tools'),
		'packages/tools/package.yml': 'matches:\n  - trigger: ":ip"\n    replace: "{{ip}}"\n    vars:\n      - name: ip\n        type: shell\n        params:\n          cmd: "ipconfig getifaddr en0"\n',
	});
	const { call, service, matchDir } = await setup(t, { aiWrite: true, serviceOptions: { git: createGit({ allowLocal: true, env: gitEnv(remote.root) }), allowLocalRepositories: true } });
	await service.connectTeam(remote.url);

	const listed = await call('snippets_list_team_packages');
	assert.deepEqual([listed.connected, listed.repository], [true, remote.url]);
	assert.deepEqual(listed.packages, [
		{ name: 'goodbyes', title: 'Goodbyes', description: 'The goodbyes package', snippet_count: 2, installed: false, update_available: false, runs_commands: false },
		{ name: 'support', title: 'Support replies', description: 'The support package', snippet_count: 4, installed: false, update_available: false, runs_commands: false },
		{ name: 'tools', title: 'Tools', description: 'The tools package', snippet_count: 1, installed: false, update_available: false, runs_commands: true },
	]);

	assert.deepEqual(await call('snippets_install_team_package', { name: 'support' }), { name: 'support', installed: true, update_available: false });
	assert.ok(readFileSync(join(matchDir, 'team', 'support', 'replies.yml'), 'utf8').includes(':refund'));
	assert.deepEqual((await call('snippets_list_files', { source: 'team' })).items.map((item) => item.file_id), ['team:support:escalations.yml', 'team:support:replies.yml']);

	assert.deepEqual(await call('snippets_install_team_package', { name: 'tools' }), {
		error: 'The tools package runs commands on the person\'s computer when its snippets are used. Ask the person whether to install it. If they agree, call again with accept_commands set to true.',
	});
	assert.equal((await call('snippets_install_team_package', { name: 'tools', accept_commands: true })).installed, true);
	assert.match((await call('snippets_install_team_package', { name: 'nothing' })).error, /no package named nothing.*snippets_list_team_packages/s);

	const proposed = await call('snippets_propose_to_team', { file_id: 'local:dates.yml', package: 'goodbyes', summary: 'Share the date snippets' });
	assert.match(proposed.branch, /^snippet-editor\/goodbyes-\d{8}-\d{6}$/);
	assert.deepEqual({ ...proposed, branch: 'b' }, { branch: 'b', pull_request_url: null, created_package: false, note: 'The branch is pushed. A person on the team opens the pull request on the repository\'s site.' });
	assert.ok(remote.branches().includes(proposed.branch));

	remote.refuseProposals();
	assert.deepEqual(await call('snippets_propose_to_team', { file_id: 'local:base.yml', package: 'goodbyes', summary: 'Share' }), { error: 'You do not have permission to push to this repository.' });
});

// --- the app ---------------------------------------------------------------------------

test('when the app cannot be reached, every tool says so in the same words, and the list of tools still works', async (t) => {
	const { tools, call, listener } = await setup(t, { aiWrite: true });
	await listener.stop();
	const expected = { error: 'Snippet Editor is not reachable. Open the app and switch on "API for other tools" in its Settings.' };
	assert.deepEqual(await call('snippets_search', { query: 'bye' }), expected);
	assert.deepEqual(await call('snippets_list_files'), expected);
	assert.deepEqual(await call('snippets_create_file', { name: 'x.yml' }), expected);
	assert.equal(tools.list().length, 12);
});

test('no reply ever carries the token', async (t) => {
	const { call, dataDir } = await setup(t, { aiWrite: true });
	const token = readFileSync(join(dataDir, 'api-token'), 'utf8').trim();
	const replies = [
		await call('snippets_list_files'),
		await call('snippets_get_file', { file_id: 'local:base.yml', detail: 'raw' }),
		await call('snippets_get_file', { file_id: 'local:missing.yml' }),
		await call('snippets_search', { query: token }),
		await call('snippets_list_team_packages'),
	];
	assert.ok(!JSON.stringify(replies).includes(token));
});

// --- added after review -----------------------------------------------------------

const SHELL = { name: 'out', type: 'shell', params: { cmd: 'echo hi' } };
const ASK_FIRST = / would run a command on the person's computer each time it is used\. Ask the person first\. If they agree, call again with accept_commands set to true\.$/;

test('a snippet that runs a command is written only when the call says the person agreed', async (t) => {
	const { call, read, version } = await setup(t, { aiWrite: true });
	const before = read('base.yml');
	const risky = { trigger: ';ip', replace: '{{out}}', vars: [{ name: 'when', type: 'date', params: { format: '%Y' } }, SHELL] };
	const script = { trigger: ';py', replace: '{{out}}', vars: [{ name: 'out', type: 'script', params: { args: ['python3', 'x.py'] } }] };

	assert.match((await call('snippets_add_snippet', { file_id: 'local:base.yml', snippet: risky, version: await version('local:base.yml') })).error, ASK_FIRST);
	assert.match((await call('snippets_add_snippet', { file_id: 'local:base.yml', snippet: script, version: await version('local:base.yml') })).error, ASK_FIRST);
	assert.match((await call('snippets_update_snippet', { file_id: 'local:base.yml', index: 0, snippet: risky, version: await version('local:base.yml') })).error, ASK_FIRST);
	for (const yaml of [
		`${before}\n  - trigger: ";ip"\n    replace: "{{out}}"\n    vars:\n      - name: out\n        type: shell\n        params:\n          cmd: "echo hi"\n`,
		before.replace('type: echo', 'type: shell'),
	]) {
		assert.match((await call('snippets_replace_file_yaml', { file_id: 'local:base.yml', yaml, version: await version('local:base.yml') })).error, ASK_FIRST);
	}
	assert.equal(read('base.yml'), before);

	// With the person's agreement, each of the three goes through.
	const added = await call('snippets_add_snippet', { file_id: 'local:base.yml', snippet: risky, version: await version('local:base.yml'), accept_commands: true });
	assert.equal(added.snippet_count, 4);
	const updated = await call('snippets_update_snippet', { file_id: 'local:base.yml', index: 0, snippet: script, version: added.version, accept_commands: true });
	assert.equal(updated.index, 0);
	const replaced = await call('snippets_replace_file_yaml', { file_id: 'local:base.yml', yaml: before.replace('type: echo', 'type: shell'), version: updated.version, accept_commands: true });
	assert.equal(replaced.snippet_count, 3);
	// A snippet that runs nothing needs no such agreement.
	assert.equal((await call('snippets_add_snippet', { file_id: 'local:base.yml', snippet: { trigger: ';plain', replace: 'type: shell is only text here' }, version: replaced.version })).snippet_count, 4);
});

test('YAML that cannot be checked for commands is not written without that agreement either', async (t) => {
	const { call, read, version } = await setup(t, { aiWrite: true });
	const before = read('base.yml');
	const long = `matches:\n  - trigger: ":long"\n    replace: "${'x'.repeat(300 * 1024)}"\n`;
	const odd = 'matches:\n  - trigger: ":odd"\n    replace: "x"\n    weight: .inf\n';
	for (const yaml of [long, odd]) {
		const refused = await call('snippets_replace_file_yaml', { file_id: 'local:base.yml', yaml, version: await version('local:base.yml') });
		assert.match(refused.error, /^This YAML could not be checked for snippets that run commands/);
	}
	assert.equal(read('base.yml'), before);
	assert.equal((await call('snippets_replace_file_yaml', { file_id: 'local:base.yml', yaml: odd, version: await version('local:base.yml'), accept_commands: true })).file_id, 'local:base.yml');
});

test('a snippet needs something to trigger it', async (t) => {
	const { call, read, version } = await setup(t, { aiWrite: true });
	const before = read('base.yml');
	for (const snippet of [{}, { replace: 'No trigger' }, { trigger: '', replace: 'x' }, { triggers: [], replace: 'x' }]) {
		const expected = { error: '`snippet` needs a `trigger`, a list of `triggers`, or a `regex`. Example: {"trigger": ":sig", "replace": "Best,\\nSam"}.' };
		assert.deepEqual(await call('snippets_add_snippet', { file_id: 'local:base.yml', snippet, version: await version('local:base.yml') }), expected, JSON.stringify(snippet));
		assert.deepEqual(await call('snippets_update_snippet', { file_id: 'local:base.yml', index: 0, snippet, version: await version('local:base.yml') }), expected);
	}
	assert.equal(read('base.yml'), before);
	assert.equal((await call('snippets_add_snippet', { file_id: 'local:base.yml', snippet: { regex: ':n(?P<n>\\d+)', replace: 'n' }, version: await version('local:base.yml') })).snippet_count, 4);
});

test('an id is one name, however it is written: nothing in it reaches another route', async (t) => {
	const { call, read, version, matchDir } = await setup(t, { aiWrite: true });
	const before = read('base.yml');
	const v = await version('local:base.yml');
	for (const fileId of ['x/../local:base.yml#', 'local:base.yml#', 'local:base.yml?version=' + v, 'local:base.yml/raw', '../state', 'local:..%2Fbase.yml', 'local:base.yml/snippets/0']) {
		assert.ok((await call('snippets_delete_snippet', { file_id: fileId, index: 0, version: v })).error, `delete with ${fileId}`);
		assert.ok((await call('snippets_get_file', { file_id: fileId })).error, `read with ${fileId}`);
		assert.ok((await call('snippets_replace_file_yaml', { file_id: fileId, yaml: 'matches: []\n', version: v })).error, `replace with ${fileId}`);
	}
	for (const name of ['../../packages/goodbyes', 'goodbyes/installed?x=', 'a#b']) assert.ok((await call('snippets_install_team_package', { name })).error, name);
	assert.equal(read('base.yml'), before);
	assert.deepEqual(readdirSync(matchDir).sort(), ['_shared.yml', 'base.yml', 'broken.yml', 'dates.yml', 'packages']);
});

test('one file with a value that cannot be sent is marked, and every other file is still listed', async (t) => {
	const { call, matchDir } = await setup(t);
	const text = 'matches:\n  - trigger: ":odd"\n    replace: "x"\n    weight: .inf\n';
	writeFileSync(join(matchDir, 'odd.yml'), text);
	const listed = await call('snippets_list_files');
	assert.equal(listed.total_count, 6);
	const odd = listed.items.find((item) => item.name === 'odd.yml');
	assert.equal(odd.snippet_count, null);
	assert.match(odd.problem, /^This file holds a value JSON cannot carry/);
	assert.match((await call('snippets_get_file', { file_id: 'local:odd.yml' })).problem, /JSON cannot carry.*detail "raw"/s);
	assert.equal((await call('snippets_get_file', { file_id: 'local:odd.yml', detail: 'raw' })).yaml, text);
	assert.deepEqual((await call('snippets_search', { query: 'odd' })).items, []);
});

test('errors point at the next call that fits what went wrong', async (t) => {
	const remote = seeded();
	const { call, service, matchDir } = await setup(t, { aiWrite: true, serviceOptions: { git: createGit({ allowLocal: true, env: gitEnv(remote.root) }), allowLocalRepositories: true } });
	await service.connectTeam(remote.url);

	// A file that is not there is a file problem, even in a team tool.
	assert.deepEqual(await call('snippets_propose_to_team', { file_id: 'local:missing.yml', package: 'goodbyes', summary: 'Share' }), {
		error: 'missing.yml is no longer in the match folder. Call snippets_list_files to see the files and their ids.',
	});
	// A folder in the way of an install is the person's to move.
	mkdirSync(join(matchDir, 'team', 'goodbyes'), { recursive: true });
	writeFileSync(join(matchDir, 'team', 'goodbyes', 'mine.yml'), 'matches: []\n');
	assert.deepEqual(await call('snippets_install_team_package', { name: 'goodbyes' }), {
		error: 'A folder named goodbyes is already in match/team and was not put there by this app. Ask the person to move or remove that folder.',
	});
	// A package name is one name: written like a path, it must not install another package.
	assert.ok((await call('snippets_install_team_package', { name: 'support/installed?x=' })).error);
	assert.equal(existsSync(join(matchDir, 'team', 'support')), false);
	// An empty file has no positions to offer.
	writeFileSync(join(matchDir, 'empty.yml'), 'matches: []\n');
	assert.deepEqual(await call('snippets_get_snippet', { file_id: 'local:empty.yml', index: 0 }), { error: 'empty.yml has no snippets.' });
	// A file that cannot be opened is not offered as raw text.
	writeFileSync(join(matchDir, 'latin.yml'), Buffer.from([0x6d, 0x61, 0x74, 0x63, 0x68, 0x65, 0x73, 0x3a, 0x20, 0xff, 0x0a]));
	const summary = await call('snippets_get_file', { file_id: 'local:latin.yml' });
	assert.match(summary.problem, /^latin\.yml could not be opened: .* It can only be changed outside this app\.$/);
	assert.ok(!summary.problem.includes('raw'));
	const raw = await call('snippets_get_file', { file_id: 'local:latin.yml', detail: 'raw' });
	assert.deepEqual(['yaml' in raw, 'version' in raw, raw.problem], [false, false, summary.problem]);
});

test('one snippet too long for a reply is named, with where to carry on', async (t) => {
	const { call, matchDir } = await setup(t);
	const long = 'word '.repeat(6000);
	writeFileSync(join(matchDir, 'mixed.yml'), `matches:\n  - trigger: ":a"\n    replace: "A"\n  - trigger: ":long"\n    replace: "${long}"\n  - trigger: ":c"\n    replace: "C"\n`);
	const first = await call('snippets_get_file', { file_id: 'local:mixed.yml', detail: 'full' });
	assert.deepEqual([first.snippets.map((item) => item.index), first.next_offset], [[0], 1]);
	assert.deepEqual(await call('snippets_get_file', { file_id: 'local:mixed.yml', detail: 'full', offset: 1 }), {
		error: 'The item at offset 1 is longer than a reply can carry. Continue with offset 2. To see that one, ask the person to open it in the app.',
	});
	assert.deepEqual((await call('snippets_get_file', { file_id: 'local:mixed.yml', detail: 'full', offset: 2 })).snippets.map((item) => item.index), [2]);
	assert.deepEqual(await call('snippets_get_snippet', { file_id: 'local:mixed.yml', index: 1 }), { error: 'This snippet is longer than a reply can carry. Ask the person to open it in the app.' });
});

test('an error is capped like any other reply, and so is a very long description', async (t) => {
	const { call, matchDir, version } = await setup(t, { aiWrite: true });
	const broken = `matches:\n${Array.from({ length: 3000 }, (_, index) => `  - trigger: ":b${index}\n    replace: "x"\n`).join('')}`;
	const refused = await call('snippets_replace_file_yaml', { file_id: 'local:base.yml', yaml: broken, version: await version('local:base.yml'), accept_commands: true });
	assert.ok(refused.error.length <= 1600, `the error was ${refused.error.length} characters`);
	assert.match(refused.error, /\.\.\. \(cut: \d+ characters in all\)$/);

	writeFileSync(join(matchDir, 'wordy.yml'), `# ${'d'.repeat(30000)}\n\nmatches: []\n`);
	const listed = (await call('snippets_list_files')).items.find((item) => item.name === 'wordy.yml');
	assert.deepEqual([listed.description.length, listed.description.endsWith('...')], [300, true]);
	assert.ok(JSON.stringify(await call('snippets_get_file', { file_id: 'local:wordy.yml', detail: 'raw' })).length <= 25000);
});

test('when more than a thousand snippets match, the count says it is only a floor', async (t) => {
	const { call, matchDir } = await setup(t);
	writeFileSync(join(matchDir, 'many.yml'), `matches:\n${Array.from({ length: 1300 }, (_, index) => `  - trigger: ":m${index}"\n    replace: "needle"\n`).join('')}`);
	const found = await call('snippets_search', { query: 'needle', limit: 5 });
	assert.deepEqual([found.total_count, found.note], [1000, 'At least 1000 snippets match, and only the first 1000 can be reached. Narrow the search.']);
	assert.equal((await call('snippets_search', { query: 'goodbye' })).note, undefined);
});

test('a match folder that is missing says so, and is not shown as a folder with no files', async (t) => {
	const { call, matchDir } = await setup(t);
	rmSync(matchDir, { recursive: true, force: true });
	assert.deepEqual(await call('snippets_list_files'), { items: [], total_count: 0, has_more: false, next_offset: null, note: 'The match folder does not exist yet. Creating a file creates it.' });
});

test('the list of team packages is paged like every other list', async (t) => {
	const remote = seeded();
	const { call, service } = await setup(t, { serviceOptions: { git: createGit({ allowLocal: true, env: gitEnv(remote.root) }), allowLocalRepositories: true } });
	await service.connectTeam(remote.url);
	const first = await call('snippets_list_team_packages', { limit: 1 });
	assert.deepEqual([first.packages.map((pkg) => pkg.name), first.total_count, first.has_more, first.next_offset], [['goodbyes'], 2, true, 1]);
	const second = await call('snippets_list_team_packages', { limit: 1, offset: 1 });
	assert.deepEqual([second.packages.map((pkg) => pkg.name), second.has_more, second.next_offset], [['support'], false, null]);
});

test('what each tool may do is marked exactly', async (t) => {
	const { tools } = await setup(t);
	const marks = Object.fromEntries(tools.list().map((tool) => [tool.name, [tool.annotations.readOnlyHint, tool.annotations.destructiveHint, tool.annotations.idempotentHint, tool.annotations.openWorldHint]]));
	assert.deepEqual(marks, {
		snippets_search: [true, false, true, false],
		snippets_list_files: [true, false, true, false],
		snippets_get_file: [true, false, true, false],
		snippets_get_snippet: [true, false, true, false],
		snippets_list_team_packages: [true, false, true, false],
		snippets_add_snippet: [false, false, false, false],
		// Changing a snippet drops the keys left out, and an update replaces installed files.
		snippets_update_snippet: [false, true, false, false],
		snippets_delete_snippet: [false, true, false, false],
		snippets_create_file: [false, false, false, false],
		snippets_replace_file_yaml: [false, true, false, false],
		snippets_install_team_package: [false, true, false, false],
		snippets_propose_to_team: [false, false, false, true],
	});
});

test('the two tools that wait on git are given longer than the rest', async () => {
	const calls = [];
	const api = {
		settings: async () => ({ apiEnabled: true, apiPort: 1, aiWrite: true }),
		request: async (method, path, options = {}) => {
			calls.push([method, path, options.timeout]);
			if (path.startsWith('/files/')) return { status: 200, body: { id: 'local:dates.yml', name: 'dates.yml', matches: [{}], text: '' } };
			if (path === '/team/proposals') return { status: 201, body: { branch: 'b', compareUrl: null, created: false } };
			return { status: 200, body: { packages: [{ name: 'goodbyes', installed: true, updateAvailable: false }] } };
		},
	};
	const tools = createTools({ api });
	await tools.call('snippets_install_team_package', { name: 'goodbyes' });
	await tools.call('snippets_propose_to_team', { file_id: 'local:dates.yml', package: 'goodbyes', summary: 'Share' });
	assert.deepEqual(calls.filter(([, path]) => path.startsWith('/team/')), [
		['PUT', '/team/packages/goodbyes/installed', 150_000],
		['POST', '/team/proposals', 150_000],
	]);
	assert.equal(calls.find(([, path]) => path.startsWith('/files/'))[2], undefined);
});

// --- in chat: a change is a proposal ----------------------------------------------------

async function chatSetup(t, options = {}) {
	const api = await startApi(t, options);
	const client = createApiClient({ dataDir: api.dataDir });
	const proposed = [];
	const state = { answer: () => ({ id: `p${proposed.length}` }) };
	const tools = createTools({
		api: client,
		propose: async (proposal) => {
			proposed.push(proposal);
			return state.answer(proposal);
		},
	});
	const call = async (name, args = {}) => {
		const result = await tools.call(name, args);
		assert.ok(result, `unknown tool ${name}`);
		if (result.isError) return { error: result.content[0].text };
		assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
		return result.structuredContent;
	};
	const read = (name) => readFileSync(join(api.matchDir, name), 'utf8');
	return { ...api, tools, plain: createTools({ api: client }), call, read, proposed, state };
}

const NOT_YET = 'Shown to the person as a card. Nothing has changed yet: it is written only if they press Apply. Say what you proposed and that it is waiting for them. Do not say it is done.';

test('in chat, each of the seven tools that change something hands over a proposal and writes nothing, switch or no switch', async (t) => {
	const { call, read, matchDir, proposed } = await chatSetup(t, { aiWrite: false });
	const before = read('base.yml');
	const v = (await call('snippets_get_file', { file_id: 'local:base.yml' })).version;
	const attempts = {
		snippets_add_snippet: { file_id: 'local:base.yml', snippet: { trigger: ';x', replace: 'X' }, version: v },
		snippets_update_snippet: { file_id: 'local:base.yml', index: 0, snippet: { trigger: ';hello', replace: 'Changed' }, version: v },
		snippets_delete_snippet: { file_id: 'local:base.yml', index: 0, version: v },
		snippets_create_file: { name: 'new.yml' },
		snippets_replace_file_yaml: { file_id: 'local:base.yml', yaml: 'matches: []\n', version: v },
		snippets_install_team_package: { name: 'goodbyes' },
		snippets_propose_to_team: { file_id: 'local:base.yml', package: 'goodbyes', summary: 'Share' },
	};
	assert.deepEqual(Object.keys(attempts), WRITE_TOOLS);
	let count = 0;
	for (const [name, args] of Object.entries(attempts)) {
		count += 1;
		assert.deepEqual(await call(name, args), { proposed: true, proposal_id: `p${count}`, note: NOT_YET }, name);
	}
	assert.deepEqual(proposed, Object.entries(attempts).map(([tool, args]) => ({ tool, args })));
	assert.equal(read('base.yml'), before);
	assert.equal(existsSync(join(matchDir, 'new.yml')), false);
});

test('in chat, a tool that changes something is described as a proposal, takes no accept_commands, and is not marked as destructive', async (t) => {
	const { tools, plain } = await chatSetup(t);
	const inChat = Object.fromEntries(tools.list().map((tool) => [tool.name, tool]));
	const outside = Object.fromEntries(plain.list().map((tool) => [tool.name, tool]));
	assert.deepEqual(Object.keys(inChat), [...READ_TOOLS, ...WRITE_TOOLS]);
	for (const name of READ_TOOLS) assert.deepEqual(inChat[name], outside[name], name);
	for (const name of WRITE_TOOLS) {
		assert.equal(
			inChat[name].description,
			`${outside[name].description} In this chat the change is not made at once: the person sees it as a card and decides. Nothing is written until they press Apply.`,
			name
		);
		assert.equal(Object.hasOwn(inChat[name].inputSchema.properties, 'accept_commands'), false, name);
		const { accept_commands: dropped, ...kept } = outside[name].inputSchema.properties;
		assert.deepEqual(inChat[name].inputSchema, { ...outside[name].inputSchema, properties: kept }, name);
		assert.deepEqual(inChat[name].annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, name);
		assert.equal(inChat[name].title, outside[name].title);
	}
	// Outside chat nothing moved.
	assert.equal(Object.hasOwn(outside.snippets_add_snippet.inputSchema.properties, 'accept_commands'), true);
	assert.equal(outside.snippets_delete_snippet.annotations.destructiveHint, true);
});

test('in chat, input is checked before anything is proposed', async (t) => {
	const { call, proposed } = await chatSetup(t);
	assert.match((await call('snippets_add_snippet', { file_id: 'local:base.yml', snippet: { trigger: ';x', replace: 'X' } })).error, /^Missing `version`/);
	assert.match((await call('snippets_delete_snippet', { file_id: 'local:base.yml', index: -1, version: 'v' })).error, /`index` must be a whole number/);
	assert.equal(
		(await call('snippets_add_snippet', { file_id: 'local:base.yml', snippet: { trigger: ';x', replace: 'X' }, version: 'v', accept_commands: true })).error,
		'Unknown input `accept_commands`. This tool takes: file_id, snippet, version, index.'
	);
	assert.deepEqual(proposed, []);
});

test('in chat, what the app says against a proposal reaches the model as an error it can act on', async (t) => {
	const { call, state, proposed } = await chatSetup(t);
	state.answer = () => ({ error: 'base.yml changed since you read it. Call snippets_get_file for local:base.yml again, look at what changed, then retry with the new version.' });
	assert.deepEqual(await call('snippets_delete_snippet', { file_id: 'local:base.yml', index: 0, version: 'old' }), {
		error: 'base.yml changed since you read it. Call snippets_get_file for local:base.yml again, look at what changed, then retry with the new version.',
	});
	assert.equal(proposed.length, 1);
});

test('in chat, a proposal that cannot be handed over says the chat has ended', async (t) => {
	const api = await startApi(t);
	const tools = createTools({
		api: createApiClient({ dataDir: api.dataDir }),
		propose: async () => {
			throw Object.assign(new Error('This chat has ended. The person can send their message again.'), { code: 'UNREACHABLE' });
		},
	});
	const result = await tools.call('snippets_create_file', { name: 'new.yml' });
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, 'This chat has ended. The person can send their message again.');
});

test('in chat, the tools that read work as they do anywhere', async (t) => {
	const { call, proposed } = await chatSetup(t);
	assert.equal((await call('snippets_search', { query: 'hello' })).items[0].file_id, 'local:base.yml');
	assert.equal((await call('snippets_get_snippet', { file_id: 'local:base.yml', index: 0 })).snippet.trigger, ';hello');
	assert.deepEqual(proposed, []);
});

test('the checks for a snippet that runs a command, and the wording of a refusal, can be used outside the tools', async () => {
	const { snippetRuns, fileRuns, explain } = await import('../mcp/tools.mjs');
	assert.equal(snippetRuns({ trigger: ':ip', replace: '{{ip}}', vars: [{ name: 'ip', type: 'shell', params: { cmd: 'x' } }] }), true);
	assert.equal(snippetRuns({ trigger: ':d', replace: '{{d}}', vars: [{ name: 'd', type: 'date' }] }), false);
	assert.equal(snippetRuns('not a snippet'), false);
	assert.equal(fileRuns({ global_vars: [{ name: 'x', type: 'script', params: {} }], matches: [] }), true);
	assert.equal(fileRuns({ matches: [{ trigger: ':a', replace: 'b' }] }), false);
	assert.match(explain({ status: 409, body: { error: { code: 'CONFLICT', message: 'x' } } }, { fileId: 'local:base.yml' }), /^base\.yml changed since you read it/);
});
