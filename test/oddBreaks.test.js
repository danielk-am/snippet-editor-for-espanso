import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRouter } from '../core/apiRouter.js';
import { createProposals } from '../core/chat/proposals.js';
import { createGit } from '../core/git.js';
import { parseMatchFile } from '../core/matchFile.js';
import { createApiClient } from '../mcp/client.mjs';
import { createTools } from '../mcp/tools.mjs';
import { diffLines } from '../renderer/lib/diff.js';
import { oddBreak } from '../shared/text.js';
import { startApi } from './helpers/apiFixture.js';
import { MANIFEST, gitEnv, seeded } from './helpers/teamRemote.js';

// Espanso ends a line at four characters that most YAML readers, this app's
// among them, take for ordinary text: a carriage return with no line feed
// after it, and U+0085, U+2028 and U+2029. (Checked against Espanso 2.4.1.)
// So text after one of them, on a comment line, is a comment here and a live
// snippet there. Written as numbers, so this file holds none of them.
const BREAKS = { 'a lone carriage return': '\r', 'U+0085': String.fromCharCode(0x85), 'U+2028': String.fromCharCode(0x2028), 'U+2029': String.fromCharCode(0x2029) };
const HIDDEN = (char) => `matches:\n  - trigger: ":hi"\n    replace: "Hello"\n  # tidy${char}  - trigger: ":sig"${char}    replace: "{{o}}"${char}    vars:${char}      - name: o${char}        type: shell${char}        params:${char}          cmd: "echo ran"\n`;
const SAYS = /^This text has a line break that Espanso reads and this app does not \(.+\), at line \d+\. Remove it, or put a normal line break there\.$/;

test('the four line breaks only Espanso reads are found, and nothing else is taken for one', () => {
	for (const [name, char] of Object.entries(BREAKS)) {
		assert.deepEqual(oddBreak(`one\ntwo${char}three\n`), { line: 2, name }, name);
	}
	for (const fine of ['', 'one\ntwo\n', 'windows\r\nline\r\nends\r\n', 'a form feed \f and a tab \t', 'written out: \\u2028 \\r \\x85']) assert.equal(oddBreak(fine), null, JSON.stringify(fine));
	assert.deepEqual(oddBreak('\r\n\r\nthird\rline'), { line: 3, name: 'a lone carriage return' });
	assert.deepEqual(oddBreak('ends with one\r'), { line: 1, name: 'a lone carriage return' });
});

test('a file that holds one is not listed as snippets: it is a file with a problem, which names the line', () => {
	for (const [name, char] of Object.entries(BREAKS)) {
		const parsed = parseMatchFile(HIDDEN(char));
		assert.equal(parsed.matches, null, name);
		assert.equal(parsed.errors.length, 1);
		assert.match(parsed.errors[0], SAYS);
		assert.ok(parsed.errors[0].includes(`(${name})`) && parsed.errors[0].includes('at line 4.'), parsed.errors[0]);
	}
	// The same characters written as YAML escapes inside quotes are ordinary text.
	const escaped = parseMatchFile('matches:\n  - trigger: ":x"\n    replace: "one\\u2028two\\rthree\\x85four"\n');
	assert.deepEqual([escaped.errors, escaped.matches.length], [[], 1]);
	assert.deepEqual(parseMatchFile('matches:\r\n  - trigger: ":x"\r\n    replace: "crlf"\r\n').errors, []);
});

test('the app does not write one into a file, by any way of saving, and says why', async (t) => {
	const api = await startApi(t, { enabled: false, aiWrite: true });
	const router = createRouter({ service: api.service, log: () => {} });
	const at = (id) => `/api/v1/files/${encodeURIComponent(id)}`;
	const read = async (id) => (await router({ method: 'GET', path: at(id) })).body;
	const onDisk = (name) => readFileSync(join(api.matchDir, name), 'utf8');
	const before = onDisk('base.yml');
	const base = await read('local:base.yml');

	for (const [name, char] of Object.entries(BREAKS)) {
		// The raw editor, and anything else that replaces a file's text.
		const raw = await router({ method: 'PUT', path: `${at('local:base.yml')}/raw`, body: { text: `${base.text}  # note${char}  - trigger: ":sig"${char}    replace: "x"\n`, version: base.version } });
		assert.deepEqual([raw.status, raw.body.error.code], [422, 'PARSE_ERROR'], name);
		assert.match(raw.body.error.message, SAYS);
		// A file's description and prefix.
		const details = await router({ method: 'PUT', path: `${at('local:base.yml')}/details`, body: { description: 'Greetings', prefix: `;${char}x`, version: base.version } });
		assert.deepEqual([details.status, details.body.error?.message], [400, 'A prefix is one line: it cannot hold a line break.'], name);
		const made = await router({ method: 'POST', path: '/api/v1/files', body: { name: 'new.yml', description: 'A file', prefix: `:${char}global_vars:` } });
		assert.deepEqual([made.status, made.body.error.code, made.body.error.message], [400, 'INVALID', 'A prefix is one line: it cannot hold a line break.'], name);
		assert.equal(existsSync(join(api.matchDir, 'new.yml')), false);
	}
	assert.equal(onDisk('base.yml'), before);

	// In a description they become spaces, as a line break always has.
	const described = await router({ method: 'POST', path: '/api/v1/files', body: { name: 'described.yml', description: `One${BREAKS['U+2028']}two${BREAKS['U+0085']}three\rfour` } });
	assert.equal(described.status, 201);
	assert.equal(onDisk('described.yml'), '# One two three four\n\nmatches: []\n');

	// In a snippet's own text they are written as escapes, so both readers see the same thing.
	const added = await router({ method: 'POST', path: `${at('local:base.yml')}/snippets`, body: { match: { trigger: ';odd', replace: `one${BREAKS['U+2028']}two\rthree` }, version: base.version } });
	assert.equal(added.status, 201);
	assert.equal(oddBreak(onDisk('base.yml')), null);
	assert.equal(added.body.matches.at(-1).replace, `one${BREAKS['U+2028']}two\rthree`);
});

test('a file that already holds one can be read and mended in the raw editor, and not edited snippet by snippet', async (t) => {
	const api = await startApi(t, { enabled: false });
	const router = createRouter({ service: api.service, log: () => {} });
	writeFileSync(join(api.matchDir, 'odd.yml'), HIDDEN('\r'));
	const path = `/api/v1/files/${encodeURIComponent('local:odd.yml')}`;
	const file = (await router({ method: 'GET', path })).body;
	assert.deepEqual([file.matches, file.matchCount, file.text], [null, null, HIDDEN('\r')]);
	assert.match(file.parseErrors[0], SAYS);
	const state = (await router({ method: 'GET', path: '/api/v1/state' })).body;
	assert.equal(state.files.find((item) => item.name === 'odd.yml').matchCount, null);
	assert.deepEqual((await router({ method: 'GET', path: '/api/v1/search', query: { q: 'sig' } })).body.filter((hit) => hit.fileName === 'odd.yml'), []);

	const added = await router({ method: 'POST', path: `${path}/snippets`, body: { match: { trigger: ':x', replace: 'X' }, version: file.version } });
	assert.equal(added.status, 422);
	// Mended: every odd break made a normal one. Now the hidden snippet shows.
	const mended = await router({ method: 'PUT', path: `${path}/raw`, body: { text: HIDDEN('\n'), version: file.version } });
	assert.equal(mended.status, 200);
	assert.deepEqual(mended.body.matches.map((match) => match.trigger), [':hi', ':sig']);
	assert.equal(mended.body.matches[1].vars[0].type, 'shell');
});

test('an AI tool cannot hide a command behind one: the change is refused, with or without a card', async (t) => {
	const api = await startApi(t, { enabled: true, aiWrite: true });
	const router = createRouter({ service: api.service, log: () => {} });
	const tools = createTools({ api: createApiClient({ dataDir: api.dataDir }) });
	const proposals = createProposals({ router, aiWrite: () => true });
	const before = readFileSync(join(api.matchDir, 'base.yml'), 'utf8');
	const version = (await tools.call('snippets_get_file', { file_id: 'local:base.yml' })).structuredContent.version;
	const hidden = `${before}  # tidy\r  - trigger: ":sig"\r    replace: "{{o}}"\r    vars:\r      - name: o\r        type: shell\r        params:\r          cmd: "echo ran"\n`;

	// Through MCP, with the switch on.
	const direct = await tools.call('snippets_replace_file_yaml', { file_id: 'local:base.yml', yaml: hidden, version });
	assert.equal(direct.isError, true);
	assert.match(direct.content[0].text, /line break that Espanso reads and this app does not \(a lone carriage return\), at line \d+/);
	const named = await tools.call('snippets_create_file', { name: 'new.yml', prefix: `:${BREAKS['U+2028']}global_vars:` });
	assert.equal(named.isError, true);

	// In chat: no card is made.
	for (const [tool, args] of [
		['snippets_replace_file_yaml', { file_id: 'local:base.yml', yaml: hidden, version }],
		['snippets_create_file', { name: 'new.yml', description: `Notes${BREAKS['U+2028']}global_vars:` }],
		['snippets_create_file', { name: 'new.yml', prefix: `:${BREAKS['U+0085']}x` }],
	]) {
		const result = await proposals.tools.call(tool, args);
		assert.equal(result.isError, true, tool);
		assert.match(result.content[0].text, /line break that Espanso reads and this app does not/);
	}
	assert.deepEqual(proposals.all(), []);
	assert.equal(readFileSync(join(api.matchDir, 'base.yml'), 'utf8'), before);
	assert.equal(existsSync(join(api.matchDir, 'new.yml')), false);
});

test('a team package that hides a command behind one counts as a package that may run commands', async (t) => {
	const remote = seeded();
	remote.commit({ 'packages/sly/_manifest.yml': MANIFEST('sly'), 'packages/sly/package.yml': HIDDEN(BREAKS['U+2028']) });
	const api = await startApi(t, { enabled: false, serviceOptions: { git: createGit({ allowLocal: true, env: gitEnv(remote.root) }), allowLocalRepositories: true } });
	await api.service.connectTeam(remote.url);
	const sly = (await api.service.teamStatus()).packages.find((pkg) => pkg.name === 'sly');
	// Not read, so not counted, and marked as one that may run commands.
	assert.deepEqual([sly.runsCommands, sly.matchCount], [true, 0]);
});

test('a card shows such text on separate rows, as Espanso would read it', () => {
	const rows = diffLines('one\n', `one\n# note${BREAKS['U+2028']}- trigger: ":sig"\rreplace: "x"${BREAKS['U+0085']}more\n`);
	assert.deepEqual(rows.filter((row) => row.kind === 'add').map((row) => row.text), ['# note', '- trigger: ":sig"', 'replace: "x"', 'more']);
	// Windows line ends are line ends, and leave nothing on a row.
	assert.deepEqual(diffLines('a\r\nb\r\n', 'a\r\nB\r\n'), [{ kind: 'same', text: 'a' }, { kind: 'remove', text: 'b' }, { kind: 'add', text: 'B' }]);
});
