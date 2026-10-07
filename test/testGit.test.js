// The tests run the real git against repositories in temporary folders. This
// is the guard that keeps every one of them off the network: if a check in
// the app that should have refused an address ever gave way, the test that
// leans on it fails here, and nothing is asked of a real server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { offline } from './helpers/teamRemote.js';

test('a test\'s git stops an address with no test repository behind it, before git is called', async () => {
	const calls = [];
	const real = async (args, options) => (calls.push([args, options]), 'ran');
	real.stopAll = () => calls.push('stopped');
	const git = offline(real, new Map([['https://github.com/acme/team.git', '/tmp/remotes/team.git']]));

	for (const stray of [
		'https://github.com/acme/other.git',
		'https://github.com/acme/team',
		'http://github.com/acme/team.git',
		'ssh://git@github.com/acme/team.git',
		'git@github.com:acme/team.git',
		'https://someone:secret@github.com/acme/team',
		'HTTPS://github.com/acme/other.git',
		'Git@github.com:acme/team.git',
	]) {
		await assert.rejects(git(['clone', '--quiet', '--', stray, '/tmp/copy'], { cwd: '/tmp' }), { message: `This test has no repository for ${stray}.` }, stray);
		await assert.rejects(git(['ls-remote', stray]), { message: `This test has no repository for ${stray}.` }, stray);
	}
	assert.deepEqual(calls, []);

	// An address with a folder behind it is handed on as that folder. A
	// folder, and everything that is no address, is handed on as it is.
	assert.equal(await git(['clone', '--', 'https://github.com/acme/team.git', '/tmp/copy'], { cwd: '/tmp' }), 'ran');
	assert.equal(await git(['clone', '--', '/tmp/remotes/other.git', '/tmp/copy']), 'ran');
	assert.equal(await git(['fetch', '--prune', 'origin', '+refs/heads/main:refs/heads/main']), 'ran');
	assert.deepEqual(calls, [
		[['clone', '--', '/tmp/remotes/team.git', '/tmp/copy'], { cwd: '/tmp' }],
		[['clone', '--', '/tmp/remotes/other.git', '/tmp/copy'], undefined],
		[['fetch', '--prune', 'origin', '+refs/heads/main:refs/heads/main'], undefined],
	]);
	// With no folders given, every address is a stray.
	await assert.rejects(offline(real)(['clone', 'https://github.com/acme/team.git']), /^Error: This test has no repository for/);
	git.stopAll();
	assert.equal(calls.at(-1), 'stopped');
});

// The test files and helpers, found by looking, so a new one is covered the day
// it is added. test/fixtures holds data, and this file only names what it looks for.
const folder = fileURLToPath(new URL('.', import.meta.url));
function sources(directory = '') {
	return readdirSync(folder + directory, { withFileTypes: true }).flatMap((entry) => {
		const name = directory + entry.name;
		if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : sources(name + '/');
		return /\.(js|mjs|cjs)$/.test(entry.name) && name !== 'testGit.test.js' ? [name] : [];
	});
}

// A string, in either kind of quote, or a regular expression, at one spot.
const STRING = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/y;
const REGEXP = /\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*/y;
const at = (pattern, text, index) => ((pattern.lastIndex = index), pattern.exec(text)?.[0]);

// Where a template literal ends, and where the `${ }` inside one does.
function endOfTemplate(text, from) {
	let i = from;
	while (i < text.length) {
		if (text[i] === '\\') i += 2;
		else if (text[i] === '`') return i + 1;
		else if (text[i] === '$' && text[i + 1] === '{') i = endOfBraces(text, i + 2);
		else i += 1;
	}
	return i;
}
function endOfBraces(text, from) {
	let i = from;
	for (let depth = 1; i < text.length && depth; ) {
		if (text[i] === '`') i = endOfTemplate(text, i + 1);
		else if (at(STRING, text, i)) i += at(STRING, text, i).length;
		else (depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0), (i += 1);
	}
	return i;
}

// The same text with its comments blanked, and with the inside of its strings,
// templates and regular expressions blanked too unless `strings` says to keep
// them. Everything keeps its place, so a name in a comment or a message is
// never taken for a call, and brackets in a message never throw one off.
function blanked(text, { strings = false } = {}) {
	const gap = (piece) => piece.replace(/[^\n]/g, ' ');
	let out = '';
	let last = '';
	for (let i = 0; i < text.length; ) {
		const rest = (pattern) => at(pattern, text, i);
		let piece = rest(/\/\/[^\n]*|\/\*[\s\S]*?\*\//y);
		if (piece) out += gap(piece);
		else if ((piece = rest(STRING))) out += strings ? piece : piece[0] + gap(piece.slice(1, -1)) + piece.at(-1);
		else if (text[i] === '`') (piece = text.slice(i, endOfTemplate(text, i + 1))), (out += strings ? piece : '`' + gap(piece.slice(1, -1)) + '`');
		else if ((!last || '(,=:[!&|?{};'.includes(last)) && (piece = rest(REGEXP))) out += strings ? piece : gap(piece);
		else out += piece = text[i];
		i += piece.length;
		if (/\S/.test(piece) && !/^\/[/*]/.test(piece)) last = piece.at(-1);
	}
	return out;
}

// What starts the app's service, or something that runs git for it. Each is
// handed a `git` of its own, and in a test that has to be the guarded one.
const STARTERS = ['createService', 'createTeam', 'createTeamRepo', 'startBackend'];

// The calls of those in a piece of source that name no `git` among their own
// options. `{ git }` and `{ git: localGit(root) }` do. A `git` inside a nested
// object, or an options object spread in, does not.
function startsWithoutGit(text) {
	const code = blanked(text);
	const found = [];
	for (const match of code.matchAll(new RegExp(`(?<![\\w$.]|function\\s)(${STARTERS.join('|')})\\s*\\(`, 'g'))) {
		let depth = 1;
		let own = '';
		for (let i = match.index + match[0].length; i < code.length && depth; i += 1) {
			if ('([{'.includes(code[i])) depth += 1;
			if (depth === 2) own += code[i];
			if (')]}'.includes(code[i])) depth -= 1;
		}
		found.push({ name: match[1], line: code.slice(0, match.index).split('\n').length, guarded: /[{,]\s*git\s*(?=[:,}])/.test(own) });
	}
	return found;
}

// The programs these test files start as the app's own: git is the app's, it
// cannot be handed one from outside, and each is on a folder of its own with
// no repository in its settings, so nothing it starts ever asks git for one.
const APP_PROGRAMS = new Map([
	['quit-smoke.mjs', 'starts the app from source on a new user data folder, and asks it to quit'],
	['packaged-smoke.mjs', 'starts the packaged app, a program of its own, on a new user data folder whose settings turn on the API and name no repository'],
]);

test('every test and helper that starts the app\'s service, or anything that runs git for it, hands it the guarded git', () => {
	const files = sources();
	for (const named of ['team.test.js', 'service.test.js', 'teamRepo.test.js', 'ui-smoke.mjs', 'helpers/apiFixture.js', 'helpers/teamRemote.js', 'mcp-eval/serve.mjs']) assert.ok(files.includes(named), `${named} is looked at`);

	const starts = new Map();
	const bare = [];
	for (const name of files) {
		const found = startsWithoutGit(readFileSync(folder + name, 'utf8'));
		starts.set(name, found.length);
		for (const call of found.filter((one) => !one.guarded)) bare.push(`${name}:${call.line} starts ${call.name}`);
	}
	assert.deepEqual(bare, [], 'each of these gets the app\'s real git: pass git: localGit(root) from helpers/teamRemote.js');
	for (const named of ['team.test.js', 'service.test.js', 'teamRepo.test.js', 'ui-smoke.mjs', 'helpers/apiFixture.js', 'mcp-eval/serve.mjs']) assert.ok(starts.get(named) > 0, `${named} starts something this looks for`);
});

test('no test makes a git of its own, runs the git program, or starts the app as a program, unless it is named here with its reason', () => {
	// The helper is the guard itself, and git.test.js tests git's own wrapper with
	// stand-ins for the program.
	const mayMake = ['git.test.js', 'helpers/teamRemote.js'];
	const programs = new Set();
	for (const name of sources()) {
		const text = readFileSync(folder + name, 'utf8');
		const code = blanked(text);
		if (!mayMake.includes(name)) {
			assert.doesNotMatch(code, /\bcreateGit\b/, `${name} makes its own git: use localGit or offline from helpers/teamRemote.js`);
			assert.doesNotMatch(blanked(text, { strings: true }), /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*['"`]git['"`]/, `${name} runs the git program itself: use localGit or offline from helpers/teamRemote.js`);
		}
		if (/\bspawn\(\s*(?:electron|binary)\b/.test(code)) programs.add(name);
	}
	assert.deepEqual([...programs].sort(), [...APP_PROGRAMS.keys()].sort(), 'a test that starts the app as a program is named in APP_PROGRAMS with its reason, and none named there has stopped doing so');
	for (const name of APP_PROGRAMS.keys()) assert.doesNotMatch(readFileSync(folder + name, 'utf8'), /team|github|git@|ssh:/i, `${name} has to stay away from team repositories to be let off the guard`);
});

test('the look for a service started without the guarded git sees what it should, and nothing else', () => {
	const unguarded = (text) => startsWithoutGit(text).filter((one) => !one.guarded).map((one) => one.name);
	assert.deepEqual(unguarded('await createService({ userDataDir: join(root, "data"), env: {} })'), ['createService']);
	assert.deepEqual(unguarded('createTeam({ dataDir, address, installed })'), ['createTeam']);
	assert.deepEqual(unguarded('createTeamRepo({ dataDir, address })'), ['createTeamRepo']);
	assert.deepEqual(unguarded('startBackend({ ipcMain, userDataDir })'), ['startBackend']);
	assert.deepEqual(unguarded('createService({ ...serviceOptions })'), ['createService']);
	assert.deepEqual(unguarded('createService(options)'), ['createService']);
	assert.deepEqual(unguarded('createService({ env: { git: localGit(root) } })'), ['createService']);
	assert.deepEqual(unguarded('createService({ dataDir: join(a, b), git })\ncreateService({ dataDir })'), ['createService']);
	for (const guarded of ['createService({ userDataDir, git })', 'createService({ userDataDir, git: localGit(root), allowLocalRepositories: true })', 'createTeam({ git, dataDir })', 'createService({ env: { A: `${join("(", b)}` }, ...more, git: watching })', 'createService({\n\tuserDataDir,\n\tgit: localGit(root),\n})'])
		assert.deepEqual(unguarded(guarded), [], guarded);
	// Not calls: a name in a comment, a message, a pattern, an import, a
	// definition, or on something else.
	for (const other of ['// createService({ userDataDir })', '/* createService({}) */', "t.test('createService({})', () => {})", 'x.match(/createService\\(/)', 'const a = `createService(${1})`', "import { createService } from '../core/service.js'", 'async function createService({ userDataDir }) {}', 'service.createService({})', 'const createServiceLater = () => 1'])
		assert.deepEqual(startsWithoutGit(other), [], other);
	// A bracket in a message does not end a call early, and what follows a
	// regular expression is still read.
	assert.deepEqual(unguarded('createService({ message: ")" })\nconst r = /[)"]/; createService({ a: 1 })'), ['createService', 'createService']);
	assert.deepEqual(unguarded("createService({ message: '(' })"), ['createService']);
});
