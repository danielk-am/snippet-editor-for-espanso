import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackends } from '../core/chat/backends.js';

const HOME = '/Users/sam';
const DESKTOP = `${HOME}/Library/Application Support/Claude/claude-code`;
const BUNDLED_CLAUDE = (version, hash) => `${DESKTOP}/${version}/${hash}/claude.app/Contents/MacOS/claude`;
const BUNDLED_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

// A computer described by what is on it.
function computer({ files = [], dirs = {}, answers = {}, ollama, env = { PATH: '/usr/bin:/bin' }, platform = 'darwin', home = HOME } = {}) {
	const asked = [];
	const backends = createBackends({
		env,
		platform,
		home,
		isFile: async (path) => files.includes(path),
		list: async (dir) => {
			if (!Object.hasOwn(dirs, dir)) throw Object.assign(new Error('no such folder'), { code: 'ENOENT' });
			return dirs[dir];
		},
		quick: async (program, args) => {
			asked.push([program, ...args]);
			const answer = answers[`${program} ${args.join(' ')}`] ?? answers[args.join(' ')];
			if (answer === undefined) return { code: 1, stdout: '' };
			if (answer instanceof Error) throw answer;
			return answer;
		},
		ollama: ollama ?? {
			version: async () => {
				throw Object.assign(new Error('Ollama is not answering on this computer.'), { code: 'NOT_RUNNING' });
			},
			models: async () => [],
		},
	});
	return { backends, asked };
}

const SIGNED_IN = { code: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}' };
const SIGNED_OUT = { code: 1, stdout: '{\n  "loggedIn": false,\n  "authMethod": "none"\n}' };
const NEW = { code: 0, stdout: '2.1.288 (Claude Code)\n' };
const byId = (list) => Object.fromEntries(list.map((item) => [item.id, item]));

// --- nothing there -------------------------------------------------------------------------

test('with nothing installed, each backend says so, and none is ready', async () => {
	const { backends } = computer();
	const status = await backends.status();
	assert.deepEqual(status.map((item) => [item.id, item.label, item.ready, item.state]), [
		['claude', 'Claude Code', false, 'missing'],
		['codex', 'Codex', false, 'missing'],
		['ollama', 'Ollama', false, 'not-running'],
	]);
	assert.deepEqual(status.map((item) => item.message), [
		'Claude Code is not installed on this computer.',
		'Codex is not installed on this computer.',
		'Ollama is not answering on this computer. Open Ollama, then press Check again.',
	]);
	assert.deepEqual(status.map((item) => [item.command, item.models]), [[null, []], [null, []], [null, []]]);
	assert.deepEqual(status.map((item) => item.sendsTo), ['Anthropic', 'OpenAI', null]);
	assert.equal(await backends.locate('claude'), null);
	assert.equal(await backends.locate('ollama'), null);
	assert.equal(await backends.locate('other'), null);
});

// --- where they are found ------------------------------------------------------------------

test('a program is looked for on the PATH first, then where it is usually installed, then inside the desktop apps', async () => {
	const onPath = computer({ files: ['/opt/tools/claude', `${HOME}/.local/bin/claude`, BUNDLED_CLAUDE('2.1.288', 'abc')], dirs: { [DESKTOP]: ['2.1.288'], [`${DESKTOP}/2.1.288`]: ['abc'] }, env: { PATH: '/usr/bin:/opt/tools::/bin' } });
	assert.equal(await onPath.backends.locate('claude'), '/opt/tools/claude');

	const usual = computer({ files: [`${HOME}/.local/bin/claude`, '/opt/homebrew/bin/codex', BUNDLED_CODEX] });
	assert.equal(await usual.backends.locate('claude'), `${HOME}/.local/bin/claude`);
	assert.equal(await usual.backends.locate('codex'), '/opt/homebrew/bin/codex');

	const bundled = computer({ files: [BUNDLED_CLAUDE('2.1.288', 'abc'), BUNDLED_CODEX], dirs: { [DESKTOP]: ['2.1.288'], [`${DESKTOP}/2.1.288`]: ['abc'] } });
	assert.equal(await bundled.backends.locate('claude'), BUNDLED_CLAUDE('2.1.288', 'abc'));
	assert.equal(await bundled.backends.locate('codex'), BUNDLED_CODEX);
});

test('inside the Claude desktop app the newest version is taken, by number and not by spelling', async () => {
	const { backends } = computer({
		files: [BUNDLED_CLAUDE('2.1.99', 'old'), BUNDLED_CLAUDE('2.1.288', 'bbb'), BUNDLED_CLAUDE('2.1.288', 'aaa'), BUNDLED_CLAUDE('2.10.1', 'empty-has-no-program')].slice(0, 3),
		dirs: { [DESKTOP]: ['2.1.99', '2.10.1', '.DS_Store', '2.1.288', 'notes'], [`${DESKTOP}/2.10.1`]: ['empty'], [`${DESKTOP}/2.1.288`]: ['aaa', 'bbb'], [`${DESKTOP}/2.1.99`]: ['old'] },
	});
	// 2.10.1 is newest but holds no program, so the next newest is taken.
	assert.equal(await backends.locate('claude'), BUNDLED_CLAUDE('2.1.288', 'bbb'));
});

test('on Windows and Linux the program\'s name and its usual places are those of that system', async () => {
	const windows = computer({ platform: 'win32', home: 'C:\\Users\\sam', env: { Path: 'C:\\Windows;C:\\tools', USERPROFILE: 'C:\\Users\\sam' }, files: ['C:\\tools\\codex.exe', 'C:\\Users\\sam\\.local\\bin\\claude.exe'] });
	assert.equal(await windows.backends.locate('codex'), 'C:\\tools\\codex.exe');
	assert.equal(await windows.backends.locate('claude'), 'C:\\Users\\sam\\.local\\bin\\claude.exe');
	// A .cmd file cannot be started without a shell, so it is not taken.
	const shim = computer({ platform: 'win32', home: 'C:\\Users\\sam', env: { Path: 'C:\\npm' }, files: ['C:\\npm\\claude.cmd', 'C:\\npm\\claude'] });
	assert.equal(await shim.backends.locate('claude'), null);

	// A Mac's app folders are not looked in on another system.
	const stray = computer({ platform: 'linux', home: HOME, env: { PATH: '/usr/bin' }, files: [BUNDLED_CODEX, BUNDLED_CLAUDE('2.1.288', 'abc')], dirs: { [DESKTOP]: ['2.1.288'], [`${DESKTOP}/2.1.288`]: ['abc'] } });
	assert.deepEqual([await stray.backends.locate('codex'), await stray.backends.locate('claude')], [null, null]);

	const linux = computer({ platform: 'linux', home: '/home/sam', env: { PATH: '/usr/bin' }, files: ['/home/sam/.local/bin/claude', '/usr/local/bin/codex'] });
	assert.equal(await linux.backends.locate('claude'), '/home/sam/.local/bin/claude');
	assert.equal(await linux.backends.locate('codex'), '/usr/local/bin/codex');
});

// --- signed in? ----------------------------------------------------------------------------

test('Claude Code is ready when it is new enough and says it is signed in', async () => {
	const { backends, asked } = computer({ files: ['/opt/homebrew/bin/claude'], answers: { '--version': NEW, 'auth status': SIGNED_IN } });
	const claude = byId(await backends.status()).claude;
	assert.deepEqual(claude, { id: 'claude', label: 'Claude Code', ready: true, state: 'ready', message: '', command: null, sendsTo: 'Anthropic', models: [] });
	assert.deepEqual(asked, [['/opt/homebrew/bin/claude', '--version'], ['/opt/homebrew/bin/claude', 'auth', 'status']]);
});

test('signed out, Claude Code says what to run, with the program\'s path quoted for a terminal', async () => {
	const path = BUNDLED_CLAUDE('2.1.288', 'abc');
	const { backends } = computer({ files: [path], dirs: { [DESKTOP]: ['2.1.288'], [`${DESKTOP}/2.1.288`]: ['abc'] }, answers: { '--version': NEW, 'auth status': SIGNED_OUT } });
	const claude = byId(await backends.status()).claude;
	assert.deepEqual([claude.ready, claude.state, claude.message], [false, 'signed-out', 'Claude Code is not signed in. Run this in a terminal, then press Check again.']);
	assert.equal(claude.command, `'${path}' auth login`);

	const plain = computer({ files: ['/opt/homebrew/bin/claude'], answers: { '--version': NEW, 'auth status': SIGNED_OUT } });
	assert.equal(byId(await plain.backends.status()).claude.command, '/opt/homebrew/bin/claude auth login');
	const quoted = computer({ files: ["/opt/it's here/claude"], env: { PATH: "/opt/it's here" }, answers: { '--version': NEW, 'auth status': SIGNED_OUT } });
	assert.equal(byId(await quoted.backends.status()).claude.command, `'/opt/it'\\''s here/claude' auth login`);
	const windows = computer({ platform: 'win32', home: 'C:\\Users\\sam', env: { Path: 'C:\\Program Files\\tools' }, files: ['C:\\Program Files\\tools\\claude.exe'], answers: { '--version': NEW, 'auth status': SIGNED_OUT } });
	assert.equal(byId(await windows.backends.status()).claude.command, '"C:\\Program Files\\tools\\claude.exe" auth login');
});

test('what Claude Code says about signing in is read as it is given, and a check that cannot be made counts as signed out', async () => {
	const state = async (answer) => byId(await computer({ files: ['/opt/homebrew/bin/claude'], answers: { '--version': NEW, 'auth status': answer } }).backends.status()).claude.state;
	assert.equal(await state({ code: 0, stdout: '{"loggedIn":true}' }), 'ready');
	assert.equal(await state({ code: 0, stdout: '{"loggedIn":false}' }), 'signed-out');
	// Not JSON: the way it ended decides.
	assert.equal(await state({ code: 0, stdout: 'Logged in as sam' }), 'ready');
	assert.equal(await state({ code: 1, stdout: 'Not logged in' }), 'signed-out');
	assert.equal(await state({ code: 0, stdout: '{"loggedIn":"yes"}' }), 'ready');
	assert.equal(await state(new Error('timed out')), 'signed-out');
	assert.equal(await state(undefined), 'signed-out');
});

test('a Claude Code too old for the flags the app relies on says so, and one whose version cannot be read is tried', async () => {
	const claude = async (version) => byId(await computer({ files: ['/opt/homebrew/bin/claude'], answers: { '--version': version, 'auth status': SIGNED_IN } }).backends.status()).claude;
	const old = await claude({ code: 0, stdout: '2.1.258 (Claude Code)' });
	assert.deepEqual([old.ready, old.state, old.message, old.command], [false, 'old', 'This Claude Code is version 2.1.258, and the app needs 2.1.259 or newer. Update Claude Code, then press Check again.', null]);
	assert.equal((await claude({ code: 0, stdout: '1.9.999' })).state, 'old');
	assert.equal((await claude({ code: 0, stdout: '2.1.259 (Claude Code)' })).state, 'ready');
	assert.equal((await claude({ code: 0, stdout: '2.2.0' })).state, 'ready');
	assert.equal((await claude({ code: 0, stdout: '3.0.0-beta.1' })).state, 'ready');
	assert.equal((await claude({ code: 0, stdout: 'claude, some future wording' })).state, 'ready');
	assert.equal((await claude(new Error('no answer'))).state, 'ready');
});

test('Codex is ready when its own check says it is signed in, and says what to run when it is not', async () => {
	const ready = computer({ files: [BUNDLED_CODEX], answers: { 'login status': { code: 0, stdout: 'Logged in using ChatGPT\n' } } });
	assert.deepEqual(byId(await ready.backends.status()).codex, { id: 'codex', label: 'Codex', ready: true, state: 'ready', message: '', command: null, sendsTo: 'OpenAI', models: [] });
	assert.deepEqual(ready.asked, [[BUNDLED_CODEX, 'login', 'status']]);

	const out = computer({ files: [BUNDLED_CODEX], answers: { 'login status': { code: 1, stdout: 'Not logged in\n' } } });
	const codex = byId(await out.backends.status()).codex;
	assert.deepEqual([codex.ready, codex.state, codex.message, codex.command], [false, 'signed-out', 'Codex is not signed in. Run this in a terminal, then press Check again.', `${BUNDLED_CODEX} login`]);
	assert.equal(byId(await computer({ files: [BUNDLED_CODEX], answers: { 'login status': new Error('hung') } }).backends.status()).codex.state, 'signed-out');
});

// --- Ollama --------------------------------------------------------------------------------

test('Ollama is ready when it is running and has a model, and its cloud models are marked', async () => {
	const withModels = computer({ ollama: { version: async () => '0.12.3', models: async () => ['gpt-oss:120b-cloud', 'llama3.2:latest', 'qwen3:cloud', 'cloudy:8b'] } });
	assert.deepEqual(byId(await withModels.backends.status()).ollama, {
		id: 'ollama',
		label: 'Ollama',
		ready: true,
		state: 'ready',
		message: '',
		command: null,
		sendsTo: null,
		models: [
			{ name: 'gpt-oss:120b-cloud', cloud: true },
			{ name: 'llama3.2:latest', cloud: false },
			{ name: 'qwen3:cloud', cloud: true },
			{ name: 'cloudy:8b', cloud: false },
		],
	});
	assert.equal(await withModels.backends.locate('ollama'), null);

	const none = computer({ ollama: { version: async () => '0.12.3', models: async () => [] } });
	const ollama = byId(await none.backends.status()).ollama;
	assert.deepEqual([ollama.ready, ollama.state, ollama.message], [false, 'no-models', 'Ollama has no models yet. Add one that can use tools, then press Check again.']);

	const half = computer({
		ollama: {
			version: async () => '0.12.3',
			models: async () => {
				throw Object.assign(new Error('Ollama is not answering on this computer.'), { code: 'NOT_RUNNING' });
			},
		},
	});
	assert.equal(byId(await half.backends.status()).ollama.state, 'not-running');
});

// --- the real checks -----------------------------------------------------------------------

test('with nothing swapped out, a real program is found on the PATH and asked, and a folder or a file that cannot be run is not taken', { skip: process.platform === 'win32' }, async () => {
	const dir = mkdtempSync(join(tmpdir(), 'snippet-editor-backends-'));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	// A stand-in for codex that answers its sign-in check.
	writeFileSync(join(bin, 'codex'), '#!/bin/sh\nif [ "$1 $2" = "login status" ]; then echo "Logged in using ChatGPT"; exit 0; fi\nexit 2\n');
	chmodSync(join(bin, 'codex'), 0o755);
	// Not programs: a folder, and a file without permission to run.
	mkdirSync(join(bin, 'claude'));
	const other = join(dir, 'other');
	mkdirSync(other);
	writeFileSync(join(other, 'claude'), '#!/bin/sh\nexit 0\n');
	chmodSync(join(other, 'claude'), 0o644);

	const backends = createBackends({ env: { PATH: `${bin}:${other}` }, home: dir, ollama: { version: async () => '1', models: async () => ['m:1'] } });
	assert.equal(await backends.locate('codex'), join(bin, 'codex'));
	assert.equal(await backends.locate('claude'), null);
	const status = byId(await backends.status());
	assert.deepEqual([status.codex.state, status.claude.state, status.ollama.state], ['ready', 'missing', 'ready']);
});
