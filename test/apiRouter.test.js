import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, refFromId } from '../core/apiRouter.js';
import { createService } from '../core/service.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/match', import.meta.url));
const at = (id) => '/api/v1/files/' + encodeURIComponent(id);
const BASE = at('local:base.yml');
const DATES = at('local:dates.yml');
const PACKAGE = at('package:goodbyes:package.yml');

async function setup(t, logged = []) {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-router-'));
	const matchDir = join(root, 'match');
	cpSync(FIXTURES, matchDir, { recursive: true });
	const service = await createService({ userDataDir: join(root, 'data'), env: { SNIPPET_EDITOR_MATCH_DIR: matchDir } });
	t.after(() => service.dispose());
	const handle = createRouter({ service, log: (error) => logged.push(error) });
	const call = (method, path, extra = {}) => handle({ method, path, ...extra });
	const version = async (path = BASE) => (await call('GET', path)).body.version;
	const read = (name) => readFileSync(join(matchDir, name), 'utf8');
	return { root, matchDir, service, call, version, read };
}

const code = (reply) => [reply.status, reply.body?.error?.code];

// --- reading ------------------------------------------------------------------

test('GET /state lists the folder, its files and its packages', async (t) => {
	const { call, matchDir } = await setup(t);
	const reply = await call('GET', '/api/v1/state');
	assert.equal(reply.status, 200);
	assert.equal(reply.body.matchDir, matchDir);
	assert.deepEqual(reply.body.files.map((file) => file.id), ['local:_shared.yml', 'local:base.yml', 'local:broken.yml', 'local:dates.yml']);
	assert.deepEqual(reply.body.packages.map((pkg) => pkg.name), ['goodbyes']);
});

test('GET /files/{id} returns one file with its text, snippets and version', async (t) => {
	const { call, read } = await setup(t);
	const reply = await call('GET', BASE);
	assert.equal(reply.status, 200);
	assert.equal(reply.body.text, read('base.yml'));
	assert.equal(reply.body.matches.length, 3);
	assert.match(reply.body.version, /^[a-f0-9]{24}$/);
});

test('a file that is not there is 404, and an id that is not a file id is 400', async (t) => {
	const { call } = await setup(t);
	assert.deepEqual(code(await call('GET', at('local:missing.yml'))), [404, 'NOT_FOUND']);
	for (const id of ['nonsense', 'local:../escape.yml', 'package:goodbyes', 'package:../..:package.yml', 'remote:base.yml']) {
		assert.deepEqual(code(await call('GET', at(id))), [400, 'INVALID_NAME'], id);
	}
});

test('file ids map to the references the store uses', () => {
	assert.deepEqual(refFromId('local:base.yml'), { source: 'local', name: 'base.yml' });
	assert.deepEqual(refFromId('local:odd:name.yml'), { source: 'local', name: 'odd:name.yml' });
	assert.deepEqual(refFromId('package:goodbyes:package.yml'), { source: 'package', package: 'goodbyes', name: 'package.yml' });
});

// --- files --------------------------------------------------------------------

test('POST /files creates a file and answers 201', async (t) => {
	const { call, read } = await setup(t);
	const reply = await call('POST', '/api/v1/files', { body: { name: 'work.yml', description: 'Work replies', prefix: ':' } });
	assert.equal(reply.status, 201);
	assert.equal(reply.body.id, 'local:work.yml');
	assert.equal(read('work.yml'), '# Work replies\n# prefix: ":"\n\nmatches: []\n');
	assert.deepEqual(code(await call('POST', '/api/v1/files', { body: { name: 'work.yml' } })), [409, 'EXISTS']);
});

test('POST /files names the field that is missing or of the wrong kind', async (t) => {
	const { call } = await setup(t);
	for (const body of [{}, { name: 5 }, { name: 'a.yml', description: 5 }, { name: 'a.yml', prefix: [] }, undefined]) {
		const reply = await call('POST', '/api/v1/files', { body });
		assert.deepEqual(code(reply), [400, 'INVALID'], JSON.stringify(body));
		assert.match(reply.body.error.message, /`(name|description|prefix)`/);
	}
	assert.deepEqual(code(await call('POST', '/api/v1/files', { body: { name: '../x.yml' } })), [400, 'INVALID_NAME']);
});

test('PUT /files/{id}/details changes the description and prefix lines only', async (t) => {
	const { call, version, read } = await setup(t);
	const before = read('base.yml');
	const reply = await call('PUT', BASE + '/details', { body: { description: 'Replies', prefix: ':', version: await version() } });
	assert.equal(reply.status, 200);
	assert.deepEqual([reply.body.description, reply.body.prefix], ['Replies', ':']);
	assert.equal(read('base.yml'), before.replace('# Greetings for support replies\n# prefix: ";"', '# Replies\n# prefix: ":"'));
	assert.deepEqual(code(await call('PUT', BASE + '/details', { body: { description: 'x', version: 'v' } })), [400, 'INVALID']);
});

test('PUT /files/{id}/raw saves valid YAML and refuses YAML that will not parse', async (t) => {
	const { call, version, read } = await setup(t);
	const before = read('base.yml');
	const broken = await call('PUT', BASE + '/raw', { body: { text: 'matches:\n  - trigger: "open\n', version: await version() } });
	assert.deepEqual(code(broken), [422, 'PARSE_ERROR']);
	assert.equal(read('base.yml'), before);
	const saved = await call('PUT', BASE + '/raw', { body: { text: 'matches: []\n', version: await version() } });
	assert.equal(saved.status, 200);
	assert.equal(read('base.yml'), 'matches: []\n');
	assert.deepEqual(code(await call('PUT', BASE + '/raw', { body: { version: 'v' } })), [400, 'INVALID']);
});

test('DELETE /files/{id} removes the file and keeps a backup', async (t) => {
	const { call, version, matchDir, service } = await setup(t);
	const reply = await call('DELETE', DATES, { query: { version: await version(DATES) } });
	assert.equal(reply.status, 200);
	assert.equal(existsSync(join(matchDir, 'dates.yml')), false);
	assert.equal(readdirSync(join(service.backupDir, 'local', 'dates.yml')).length, 1);
});

// --- snippets -----------------------------------------------------------------

test('POST /files/{id}/snippets adds a snippet at the end, or at a position', async (t) => {
	const { call, version, read } = await setup(t);
	const added = await call('POST', BASE + '/snippets', { body: { match: { trigger: ';new', replace: 'New' }, version: await version() } });
	assert.equal(added.status, 201);
	assert.equal(added.body.matches.length, 4);
	assert.deepEqual(added.body.matches[3], { trigger: ';new', replace: 'New' });
	const placed = await call('POST', BASE + '/snippets', { body: { match: { trigger: ';second', replace: '2' }, index: 1, version: await version() } });
	assert.equal(placed.body.matches[1].trigger, ';second');
	assert.ok(read('base.yml').includes('  - trigger: ";new"\n    replace: "New"\n'));
});

test('snippet routes refuse input of the wrong kind before touching the file', async (t) => {
	const { call, version, read } = await setup(t);
	const before = read('base.yml');
	const v = await version();
	assert.deepEqual(code(await call('POST', BASE + '/snippets', { body: { match: 'text', version: v } })), [400, 'INVALID']);
	assert.deepEqual(code(await call('POST', BASE + '/snippets', { body: { match: ['list'], version: v } })), [400, 'INVALID']);
	assert.deepEqual(code(await call('POST', BASE + '/snippets', { body: { match: { trigger: ':a' }, index: 1.5, version: v } })), [400, 'INVALID']);
	assert.deepEqual(code(await call('POST', BASE + '/snippets', { body: { match: { trigger: ':a' }, index: -1, version: v } })), [400, 'INVALID']);
	// Forms a number parser would accept, but which are not a position.
	for (const index of ['abc', '0x1', '1e0', '1.0', '-1', ' 1']) {
		const reply = await call('PUT', BASE + '/snippets/' + encodeURIComponent(index), { body: { match: { trigger: ';x', replace: 'X' }, version: v } });
		assert.deepEqual(code(reply), [400, 'INVALID'], index);
		assert.match(reply.body.error.message, /whole number/, index);
	}
	assert.deepEqual(code(await call('PUT', BASE + '/snippets/0', { body: { version: v } })), [400, 'INVALID']);
	assert.deepEqual(code(await call('PUT', BASE + '/snippets/99', { body: { match: { trigger: ':a', replace: 'A' }, version: v } })), [400, 'INVALID']);
	assert.equal(read('base.yml'), before);
});

test('PUT /files/{id}/snippets/{index} changes one snippet and nothing else', async (t) => {
	const { call, version, read } = await setup(t);
	const before = read('base.yml');
	const reply = await call('PUT', BASE + '/snippets/0', { body: { match: { trigger: ';hello', replace: 'Hello again' }, version: await version() } });
	assert.equal(reply.status, 200);
	assert.equal(read('base.yml'), before.replace('"Hello there"', '"Hello again"'));
});

test('a write with a stale or missing version is 409 and changes nothing', async (t) => {
	const { call, read } = await setup(t);
	const before = read('base.yml');
	const match = { trigger: ';hello', replace: 'Mine' };
	assert.deepEqual(code(await call('PUT', BASE + '/snippets/0', { body: { match, version: 'stale' } })), [409, 'CONFLICT']);
	assert.deepEqual(code(await call('PUT', BASE + '/snippets/0', { body: { match } })), [409, 'CONFLICT']);
	assert.deepEqual(code(await call('DELETE', BASE + '/snippets/0', { query: {} })), [409, 'CONFLICT']);
	assert.deepEqual(code(await call('DELETE', BASE, { query: { version: 'stale' } })), [409, 'CONFLICT']);
	assert.equal(read('base.yml'), before);
});

test('two writes sent at once on one version: one lands and one is refused', async (t) => {
	const { call, version } = await setup(t);
	const v = await version();
	const replies = await Promise.all([
		call('POST', BASE + '/snippets', { body: { match: { trigger: ';one', replace: '1' }, version: v } }),
		call('POST', BASE + '/snippets', { body: { match: { trigger: ';two', replace: '2' }, version: v } }),
	]);
	assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 409]);
	assert.equal((await call('GET', BASE)).body.matches.length, 4);
});

test('DELETE /files/{id}/snippets/{index} removes that snippet', async (t) => {
	const { call, version } = await setup(t);
	const reply = await call('DELETE', DATES + '/snippets/1', { query: { version: await version(DATES) } });
	assert.equal(reply.status, 200);
	assert.deepEqual(reply.body.matches.map((match) => match.trigger ?? match.regex), [':today', ':ticket(?P<id>\\d+)', ':shrug']);
});

test('package files are read-only: 403', async (t) => {
	const { call, version } = await setup(t);
	const v = await version(PACKAGE);
	assert.deepEqual(code(await call('PUT', PACKAGE + '/snippets/0', { body: { match: { trigger: ':bye', replace: 'x' }, version: v } })), [403, 'READ_ONLY']);
	assert.deepEqual(code(await call('DELETE', PACKAGE, { query: { version: v } })), [403, 'READ_ONLY']);
});

test('an edit that cannot be shown to be exact is refused and points to the raw editor', async (t) => {
	const { call, version, matchDir } = await setup(t);
	const text = [
		'global_vars:',
		'  - name: g',
		'    type: echo',
		'    params: &p {echo: one}',
		'matches:',
		'  - trigger: ":a"',
		'    replace: "a"',
		'    vars:',
		'      - name: v',
		'        type: echo',
		'        params: &p {echo: two}',
		'  - trigger: ":b"',
		'    replace: "b"',
		'    vars:',
		'      - name: w',
		'        type: echo',
		'        params: *p',
		'',
	].join('\n');
	writeFileSync(join(matchDir, 'anchors.yml'), text);
	const path = at('local:anchors.yml');
	const reply = await call('DELETE', path + '/snippets/0', { query: { version: await version(path) } });
	assert.deepEqual(code(reply), [400, 'INVALID']);
	assert.match(reply.body.error.message, /raw YAML editor/);
	assert.equal(readFileSync(join(matchDir, 'anchors.yml'), 'utf8'), text);
});

// --- search and YAML helpers --------------------------------------------------

test('GET /search finds snippets across files and packages', async (t) => {
	const { call } = await setup(t);
	const reply = await call('GET', '/api/v1/search', { query: { q: 'goodbye' } });
	assert.equal(reply.status, 200);
	assert.deepEqual(reply.body.map((hit) => [hit.fileId, hit.index]), [['package:goodbyes:package.yml', 0]]);
	assert.equal((await call('GET', '/api/v1/search', { query: { q: 'e', limit: '2' } })).body.length, 2);
	assert.deepEqual(code(await call('GET', '/api/v1/search', { query: {} })), [400, 'INVALID']);
	for (const limit of ['0', '1.5', 'many', '1001']) {
		assert.deepEqual(code(await call('GET', '/api/v1/search', { query: { q: 'e', limit } })), [400, 'INVALID'], limit);
	}
});

test('the YAML helpers preview, parse and write', async (t) => {
	const { call } = await setup(t);
	const preview = await call('POST', '/api/v1/yaml/preview', { body: { match: { trigger: ':a', replace: 'A' } } });
	assert.deepEqual([preview.status, preview.body], [200, { yaml: '- trigger: ":a"\n  replace: "A"\n' }]);
	const parsed = await call('POST', '/api/v1/yaml/parse', { body: { text: 'left_word: true\npriority: 3\n' } });
	assert.deepEqual([parsed.status, parsed.body], [200, { value: { left_word: true, priority: 3 } }]);
	assert.deepEqual((await call('POST', '/api/v1/yaml/parse', { body: { text: '' } })).body, { value: null });
	assert.deepEqual(code(await call('POST', '/api/v1/yaml/parse', { body: { text: 'a: [' } })), [422, 'PARSE_ERROR']);
	assert.deepEqual(code(await call('POST', '/api/v1/yaml/parse', { body: { text: 'a: *missing' } })), [422, 'PARSE_ERROR']);
	const written = await call('POST', '/api/v1/yaml/stringify', { body: { value: { a: 1 } } });
	assert.deepEqual([written.status, written.body], [200, { yaml: 'a: 1\n' }]);
	assert.deepEqual(code(await call('POST', '/api/v1/yaml/stringify', { body: {} })), [400, 'INVALID']);
	assert.deepEqual(code(await call('POST', '/api/v1/yaml/preview', { body: { match: 'x' } })), [400, 'INVALID']);
});

// --- everything else ----------------------------------------------------------

test('an unknown path is 404 and a known path with the wrong method is 405', async (t) => {
	const { call } = await setup(t);
	assert.deepEqual(code(await call('GET', '/api/v1/nothing')), [404, 'NOT_FOUND']);
	assert.deepEqual(code(await call('GET', '/api/v2/state')), [404, 'NOT_FOUND']);
	assert.deepEqual(code(await call('GET', '/state')), [404, 'NOT_FOUND']);
	assert.deepEqual(code(await call('POST', '/api/v1/state')), [405, 'METHOD_NOT_ALLOWED']);
	assert.deepEqual(code(await call('PATCH', BASE)), [405, 'METHOD_NOT_ALLOWED']);
	assert.deepEqual(code(await call('GET', '/api/v1/files/%E0%A4%A')), [400, 'INVALID']);
	assert.deepEqual(code(await call('GET', '/api/v1/files/')), [404, 'NOT_FOUND']);
	assert.deepEqual(code(await call('PUT', '/api/v1/files//raw', { body: { text: '', version: 'v' } })), [404, 'NOT_FOUND']);
});

test('a failure of the disk is answered in plain words, without the path', async (t) => {
	const logged = [];
	const { service } = await setup(t, logged);
	const failing = (errno) => ({
		...service,
		state: async () => {
			throw Object.assign(new Error(`${errno}: something low-level, write '/Users/someone/private.yml'`), { code: errno });
		},
	});
	const answer = async (errno) => (await createRouter({ service: failing(errno), log: (error) => logged.push(error) })({ method: 'GET', path: '/api/v1/state' }));
	assert.deepEqual((await answer('ENOSPC')).body, { error: { code: 'ERROR', message: 'The disk is full, so nothing was saved.' } });
	assert.deepEqual((await answer('EACCES')).body, { error: { code: 'ERROR', message: 'Permission was denied for that file or folder.' } });
	assert.deepEqual((await answer('EROFS')).body, { error: { code: 'ERROR', message: 'That folder is read-only.' } });
	assert.equal((await answer('ENOSPC')).status, 500);
	assert.equal(logged.length, 4);
});

test('a bug inside a route is answered with 500 and a plain message, and is logged', async (t) => {
	const logged = [];
	const { service } = await setup(t, logged);
	const handle = createRouter({ service: { ...service, state: async () => { throw new Error('secret detail'); } }, log: (error) => logged.push(error) });
	const reply = await handle({ method: 'GET', path: '/api/v1/state' });
	assert.deepEqual(code(reply), [500, 'ERROR']);
	assert.ok(!reply.body.error.message.includes('secret detail'));
	assert.equal(logged.length, 1);
	assert.equal(logged[0].message, 'secret detail');
});

// --- added after review ---------------------------------------------------------

test('every write route refuses a missing or stale version and leaves the folder as it was', async (t) => {
	const { call, matchDir } = await setup(t);
	const snapshot = () => Object.fromEntries(readdirSync(matchDir).filter((name) => name.endsWith('.yml')).map((name) => [name, readFileSync(join(matchDir, name), 'utf8')]));
	const before = snapshot();
	const match = { trigger: ';x', replace: 'X' };
	const writes = [
		['PUT', BASE + '/details', { description: 'Changed', prefix: ':' }],
		['PUT', BASE + '/raw', { text: 'matches: []\n' }],
		['POST', BASE + '/snippets', { match }],
		['PUT', BASE + '/snippets/0', { match }],
	];
	for (const [method, path, body] of writes) {
		assert.deepEqual(code(await call(method, path, { body })), [409, 'CONFLICT'], `${method} ${path} with no version`);
		assert.deepEqual(code(await call(method, path, { body: { ...body, version: 'stale' } })), [409, 'CONFLICT'], `${method} ${path} with a stale version`);
		assert.deepEqual(code(await call(method, path, { body: { ...body, version: 5 } })), [409, 'CONFLICT'], `${method} ${path} with a version that is not text`);
	}
	for (const path of [BASE, BASE + '/snippets/0']) {
		assert.deepEqual(code(await call('DELETE', path, { query: {} })), [409, 'CONFLICT'], `DELETE ${path} with no version`);
		assert.deepEqual(code(await call('DELETE', path, { query: { version: 'stale' } })), [409, 'CONFLICT'], `DELETE ${path} with a stale version`);
	}
	assert.deepEqual(snapshot(), before);
});

test('each refused field is named exactly', async (t) => {
	const { call, version } = await setup(t);
	const message = async (method, path, body) => (await call(method, path, { body })).body.error.message;
	assert.equal(await message('POST', '/api/v1/files', {}), '`name` must be text.');
	assert.equal(await message('POST', '/api/v1/files', { name: 'a.yml', description: 5 }), '`description` must be text.');
	assert.equal(await message('POST', '/api/v1/files', { name: 'a.yml', prefix: [] }), '`prefix` must be text.');
	assert.equal(await message('PUT', BASE + '/details', { prefix: ':', version: 'v' }), '`description` must be text.');
	assert.equal(await message('PUT', BASE + '/details', { description: 'x', version: 'v' }), '`prefix` must be text.');
	assert.equal(await message('PUT', BASE + '/raw', { version: 'v' }), '`text` must be text.');
	assert.equal(await message('POST', BASE + '/snippets', { match: 'x', version: await version() }), '`match` must be a mapping of snippet keys.');
	assert.equal(await message('POST', BASE + '/snippets', { match: {}, index: '1', version: await version() }), '`index` must be a whole number, zero or more.');
});

test('a search limit must be written as a plain whole number', async (t) => {
	const { call } = await setup(t);
	for (const limit of [' 2 ', '0x2', '1e2', '2.0', '+2', '']) {
		assert.deepEqual(code(await call('GET', '/api/v1/search', { query: { q: 'e', limit } })), [400, 'INVALID'], JSON.stringify(limit));
	}
	assert.equal((await call('GET', '/api/v1/search', { query: { q: 'e', limit: '3' } })).body.length, 3);
});

test('a write that would make a file too large is 413, and a refused description is 400 with the reason', async (t) => {
	const { call, version, read } = await setup(t);
	const before = read('base.yml');
	const big = 'x'.repeat(2 * 1024 * 1024 + 1);
	assert.deepEqual(code(await call('PUT', BASE + '/raw', { body: { text: `matches:\n  - trigger: ":a"\n    replace: "${big}"\n`, version: await version() } })), [413, 'TOO_LARGE']);
	assert.deepEqual(code(await call('POST', BASE + '/snippets', { body: { match: { trigger: ':big', replace: big }, version: await version() } })), [413, 'TOO_LARGE']);
	assert.equal(read('base.yml'), before);
	const refused = await call('POST', '/api/v1/files', { body: { name: 'work.yml', description: 'prefix: x' } });
	assert.deepEqual(code(refused), [400, 'INVALID']);
	assert.match(refused.body.error.message, /description cannot start with/);
});

test('a file that cannot be opened is read as a described record and refuses writes with 403', async (t) => {
	const { call, matchDir } = await setup(t);
	mkdirSync(join(matchDir, 'folder.yml'));
	const path = at('local:folder.yml');
	const reply = await call('GET', path);
	assert.deepEqual([reply.status, reply.body.unreadable, reply.body.parseErrors], [200, true, ['This is a folder, not a file.']]);
	assert.deepEqual(code(await call('PUT', path + '/raw', { body: { text: 'matches: []\n', version: '' } })), [403, 'READ_ONLY']);
	assert.deepEqual(code(await call('DELETE', path, { query: { version: '' } })), [403, 'READ_ONLY']);
});

test('YAML helpers refuse text that is too long and values nested too deeply, without a 500', async (t) => {
	const logged = [];
	const { call } = await setup(t, logged);
	const long = await call('POST', '/api/v1/yaml/parse', { body: { text: 'a: ' + 'x'.repeat(256 * 1024) } });
	assert.deepEqual(code(long), [413, 'TOO_LARGE']);
	assert.equal((await call('POST', '/api/v1/yaml/parse', { body: { text: 'a: ' + 'x'.repeat(1000) } })).status, 200);
	let deep = {};
	for (let level = 0; level < 20000; level += 1) deep = { a: deep };
	assert.deepEqual(code(await call('POST', '/api/v1/yaml/stringify', { body: { value: deep } })), [400, 'INVALID']);
	assert.deepEqual(code(await call('POST', '/api/v1/yaml/preview', { body: { match: deep } })), [400, 'INVALID']);
	assert.equal(logged.length, 0);
});

test('the reply to a bug is exactly the plain error and nothing more', async (t) => {
	const { service } = await setup(t);
	const handle = createRouter({ service: { ...service, state: async () => { throw new Error('secret detail'); } }, log: () => {} });
	assert.deepEqual(await handle({ method: 'GET', path: '/api/v1/state' }), { status: 500, body: { error: { code: 'ERROR', message: 'Something went wrong inside the app.' } } });
});

// --- team files -------------------------------------------------------------------

test('an installed team file is read by its id, listed in /state, searched, and refused for every write', async (t) => {
	const { call, matchDir } = await setup(t);
	const dir = join(matchDir, 'team', 'farewells');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, '_manifest.yml'), 'name: farewells\ntitle: Farewells\n');
	writeFileSync(join(dir, 'package.yml'), 'matches:\n  - trigger: ":farewell"\n    replace: "Farewell."\n');
	assert.deepEqual(refFromId('team:farewells:package.yml'), { source: 'team', package: 'farewells', name: 'package.yml' });

	const state = (await call('GET', '/api/v1/state')).body;
	assert.deepEqual(state.team.map((pkg) => [pkg.name, pkg.title, pkg.files.map((file) => file.id)]), [['farewells', 'Farewells', ['team:farewells:package.yml']]]);
	const path = at('team:farewells:package.yml');
	const file = await call('GET', path);
	assert.deepEqual([file.status, file.body.source, file.body.readOnly, file.body.matches.length], [200, 'team', true, 1]);
	assert.deepEqual((await call('GET', '/api/v1/search', { query: { q: 'farewell' } })).body.map((hit) => hit.fileId), ['team:farewells:package.yml']);

	const { version } = file.body;
	const match = { trigger: ':farewell', replace: 'Mine' };
	assert.deepEqual(code(await call('PUT', path + '/snippets/0', { body: { match, version } })), [403, 'READ_ONLY']);
	assert.deepEqual(code(await call('POST', path + '/snippets', { body: { match, version } })), [403, 'READ_ONLY']);
	assert.deepEqual(code(await call('PUT', path + '/raw', { body: { text: 'matches: []\n', version } })), [403, 'READ_ONLY']);
	assert.deepEqual(code(await call('DELETE', path, { query: { version } })), [403, 'READ_ONLY']);
	assert.deepEqual(code(await call('GET', at('team:farewells'))), [400, 'INVALID_NAME']);
	assert.deepEqual(code(await call('GET', at('team:../x:package.yml'))), [400, 'INVALID_NAME']);
});

// --- team routes ------------------------------------------------------------------

test('the route that checks one team repository takes its id as one name, under POST only', async (t) => {
	const { call } = await setup(t);
	const told = (reply) => [reply.status, reply.body.error.code, reply.body.error.message];
	// None is connected here, so every id is one that is not. Whatever the id holds, it is looked up as one name.
	for (const id of ['0123456789ab', 'x', 'a%2Fb', '..%2F..%2Fstate', '%20', 'refresh']) {
		assert.deepEqual(told(await call('POST', `/api/v1/team/repositories/${id}/refresh`)), [404, 'NOT_FOUND', 'That repository is not connected.'], id);
	}
	for (const method of ['GET', 'PUT', 'DELETE']) assert.deepEqual(code(await call(method, '/api/v1/team/repositories/0123456789ab/refresh')), [405, 'METHOD_NOT_ALLOWED'], method);
	for (const path of ['/api/v1/team/repositories', '/api/v1/team/repositories/0123456789ab', '/api/v1/team/repositories//refresh', '/api/v1/team/repositories/0123456789ab/refresh/more', '/api/v1/team/repositories/a/b/refresh']) {
		assert.deepEqual(told(await call('POST', path)), [404, 'NOT_FOUND', 'There is nothing at that path.'], path);
	}
	assert.deepEqual(code(await call('POST', '/api/v1/team/repositories/%E0%A4%A/refresh')), [400, 'INVALID']);
});

test('a repository named in a body is text, checked before anything is looked up', async (t) => {
	const { call } = await setup(t);
	const proposal = { fileId: 'local:dates.yml', package: 'goodbyes', summary: 'Share' };
	for (const repository of [7, null, false, ['0123456789ab'], { id: '0123456789ab' }]) {
		const expected = { status: 400, body: { error: { code: 'INVALID', message: '`repository` must be text.' } } };
		assert.deepEqual(await call('PUT', '/api/v1/team/packages/goodbyes/installed', { body: { repository } }), expected, JSON.stringify(repository));
		assert.deepEqual(await call('POST', '/api/v1/team/proposals', { body: { ...proposal, repository } }), expected, JSON.stringify(repository));
	}
	// Left out, in a body that is no mapping at all, it is simply not named.
	for (const body of [undefined, null, 'x', [], 7]) {
		assert.deepEqual(code(await call('PUT', '/api/v1/team/packages/goodbyes/installed', { body })), [409, 'NOT_CONNECTED'], JSON.stringify(body));
		assert.deepEqual(code(await call('POST', '/api/v1/team/proposals', { body })), [409, 'NOT_CONNECTED'], JSON.stringify(body));
	}
});
