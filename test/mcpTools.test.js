import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
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

	const raw = await call('snippets_get_file', { file_id: 'local:big.yml', detail: 'raw' });
	assert.ok(JSON.stringify(raw).length <= 25000);
	assert.equal(raw.truncated, true);
	assert.match(raw.note, /^The YAML is cut to its first \d+ characters of \d+\. Read the snippets in pages with detail "full", limit and offset\.$/);

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
