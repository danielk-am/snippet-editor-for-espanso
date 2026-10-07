// End-to-end check of the real window, run with `npm run test:ui`.
// Electron loads the app's own main-process modules against a throwaway copy
// of the fixtures, drives the UI, checks what reached the disk and saves
// screenshots to test/.artifacts for review.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { createGit } from '../core/git.js';
import { startBackend } from '../electron/bootstrap.js';
import { mcpSetup } from '../electron/mcpSetup.js';
import { MANIFEST, MATCHES, createRemote, gitEnv, seeded } from './helpers/teamRemote.js';
import { createMainWindow, isTrustedSender } from '../electron/window.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(here, '.artifacts');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'snippet-editor-ui-'));
const matchDir = path.join(sandbox, 'match');
fs.cpSync(path.join(here, 'fixtures', 'match'), matchDir, { recursive: true });
fs.rmSync(artifacts, { recursive: true, force: true });
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(sandbox, 'userData'));

// A port nothing else is using, so the listener step cannot clash with
// another program. The listener itself stays off until the test turns it on.
const apiPort = await new Promise((resolve) => {
	const probe = net.createServer();
	probe.listen(0, '127.0.0.1', () => {
		const { port } = probe.address();
		probe.close(() => resolve(port));
	});
});
fs.mkdirSync(path.join(sandbox, 'userData'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'userData', 'settings.json'), JSON.stringify({ apiPort }));

const failures = [];
// The process number of an answer left under way on purpose, looked for after the app has shut its backend down.
let leftRunning = null;
const consoleProblems = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => {
	if (!condition) failures.push(message);
};
const onDisk = (name) => fs.readFileSync(path.join(matchDir, name), 'utf8');

const HELPERS = `
window.__ui = {
	byText(text, selector = 'button') {
		return [...document.querySelectorAll(selector)].find((el) => el.textContent.trim() === text);
	},
	click(text, selector) {
		const el = this.byText(text, selector);
		if (!el) throw new Error('No element with text: ' + text);
		el.click();
	},
	type(selector, value) {
		const el = document.querySelector(selector);
		if (!el) throw new Error('No element: ' + selector);
		const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
		el.dispatchEvent(new Event('input', { bubbles: true }));
	},
	key(key, init = {}) {
		(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
	},
	// Picks an option of a select, as a person would.
	choose(selector, value) {
		const el = document.querySelector(selector);
		if (!el) throw new Error('No element: ' + selector);
		if (![...el.options].some((option) => option.value === value)) throw new Error('No option ' + value + ' in ' + selector);
		el.value = value;
		el.dispatchEvent(new Event('change', { bubbles: true }));
	},
	// Controls a screen reader could not name, and controls too small to hit.
	audit() {
		const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
		const controls = [...document.querySelectorAll('button, input, select, textarea, a[href]')].filter(visible);
		const named = (el) =>
			el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.labels && el.labels.length) || (el.tagName === 'BUTTON' && el.textContent.trim());
		const describe = (el) => el.tagName.toLowerCase() + '.' + el.className + ' "' + el.textContent.trim().slice(0, 30) + '"';
		const layer = (selector) => {
			const el = document.querySelector(selector);
			return el ? Number(getComputedStyle(el).zIndex) : null;
		};
		const box = document.querySelector('.overlay .dialog, .overlay .palette')?.getBoundingClientRect();
		return {
			// An open dialog sits in the middle of the window, whatever it says.
			offCentre: Boolean(box) && Math.abs((box.left + box.right) / 2 - window.innerWidth / 2) > 2,
			// A dialog asks a question; a passing notice must not sit on top of it.
			buried: layer('.overlay') !== null && layer('.toasts') !== null && layer('.overlay') <= layer('.toasts'),
			unnamed: controls.filter((el) => !named(el)).map(describe),
			small: controls
				.filter((el) => !el.matches('.sidebar__resize'))
				.filter((el) => { const r = el.getBoundingClientRect(); return Math.min(r.width, r.height) < 24; })
				.map(describe),
			// The page itself, or the pane that scrolls inside it.
			overflow: document.documentElement.scrollWidth > window.innerWidth || [...document.querySelectorAll('.content')].some((el) => el.scrollWidth > el.clientWidth),
		};
	},
};
true;
`;

// Whatever happens, the run must end with an exit code rather than hang.
const watchdog = setTimeout(() => {
	console.error('UI smoke: timed out after 180 seconds');
	app.exit(1);
}, 180000);

async function run() {
	let win = null;
	// What the app copies lands here, not on the real clipboard.
	const copied = [];
	// Two team repositories in the sandbox, reached with the real git. Both
	// offer `goodbyes`. The first also offers `support` and `tools`, which runs
	// commands, and the second `shipping`. Links the app would open in a
	// browser land in `opened` instead.
	const remote = seeded(path.join(sandbox, 'team-remote'));
	remote.commit({
		'packages/tools/_manifest.yml': MANIFEST('tools'),
		'packages/tools/package.yml': 'matches:\n  - trigger: ":ip"\n    replace: "{{ip}}"\n    vars:\n      - name: ip\n        type: shell\n        params:\n          cmd: "ipconfig getifaddr en0"\n',
	});
	const second = createRemote(path.join(sandbox, 'team-remote-2'));
	second.commit({
		'packages/goodbyes/_manifest.yml': MANIFEST('goodbyes', { description: 'How the support desk signs off' }),
		'packages/goodbyes/package.yml': MATCHES([':later', 'See you later']),
		'packages/shipping/_manifest.yml': MANIFEST('shipping'),
		'packages/shipping/package.yml': MATCHES([':sent', 'Your parcel is on its way.'], [':late', 'Your parcel is late.']),
	});
	// The app runs as it really does, where only an address on GitHub is a
	// repository. Git alone is pointed at a folder in the sandbox when it is
	// asked for one of these addresses. An address with no folder behind it
	// never gets as far as git, so nothing here can reach the network.
	const TEAM = { first: 'https://github.com/acme/team-snippets.git', second: 'git@github.com:acme/support-snippets.git' };
	const folders = new Map([[TEAM.first, remote.url], [TEAM.second, second.url]]);
	const realGit = createGit({ allowLocal: true, env: gitEnv(remote.root) });
	const git = (args, options) => {
		const stray = args.find((arg) => /^(https?:|ssh:|git@)/.test(arg) && !folders.has(arg));
		if (stray) return Promise.reject(Object.assign(new Error(`This check has no repository for ${stray}.`), { code: 'GIT_FAILED' }));
		return realGit(args.map((arg) => folders.get(arg) ?? arg), options);
	};
	git.stopAll = () => realGit.stopAll();
	const opened = [];
	// The assistant's backends are stand-ins: a script that starts the app's
	// real MCP server and prints what Codex would. No model is called. Which
	// of them is ready can be changed while the test runs.
	const chatReady = { codex: false, ollama: false };
	const chatEntry = (id, label, state, extra = {}) => ({ id, label, ready: state === 'ready', state, message: '', command: null, sendsTo: null, models: [], ...extra });
	const chatStatus = () => [
		chatEntry('claude', 'Claude Code', 'missing', { sendsTo: 'Anthropic', message: 'Claude Code is not installed on this computer.' }),
		chatReady.codex
			? chatEntry('codex', 'Codex', 'ready', { sendsTo: 'OpenAI' })
			: chatEntry('codex', 'Codex', 'signed-out', { sendsTo: 'OpenAI', message: 'Codex is not signed in. Run this in a terminal, then press Check again.', command: '/opt/tools/codex login' }),
		chatReady.ollama
			? chatEntry('ollama', 'Ollama', 'ready', { models: [{ name: 'in-the-cloud:cloud', cloud: true }, { name: 'on-this-computer:8b', cloud: false }] })
			: chatEntry('ollama', 'Ollama', 'not-running', { message: 'Ollama is not answering on this computer. Open Ollama, then press Check again.' }),
	];
	const backend = await startBackend({
		ipcMain,
		userDataDir: app.getPath('userData'),
		env: { SNIPPET_EDITOR_MATCH_DIR: matchDir },
		onChange: () => win?.webContents.send('data:changed'),
		onChatEvent: (event) => win?.webContents.send('chat:event', event),
		chatOptions: { backends: { status: async () => chatStatus(), locate: async () => path.join(here, 'helpers', 'fakeAgent.mjs') } },
		getWindow: () => win,
		isTrustedSender,
		clipboard: { writeText: (text) => copied.push(text) },
		openExternal: async (url) => opened.push(url),
		git,
		mcp: mcpSetup({ packaged: false, execPath: process.execPath, resourcesPath: process.resourcesPath, appPath: path.join(here, '..') }),
	});
	const services = backend.service;

	// The window refreshes its picture of the folder after each save. That
	// can be slowed here, so a step that acts on a stale picture fails every
	// time instead of now and then.
	const loadState = services.state.bind(services);
	let stateDelay = 0;
	services.state = async () => {
		await sleep(stateDelay);
		return loadState();
	};
	// The next connect or disconnect can be held back for a while, so that a
	// step can leave the page, or open another, while it is still under way.
	let teamDelay = 0;
	for (const name of ['connectTeam', 'disconnectTeam']) {
		const real = services[name].bind(services);
		services[name] = async (...args) => {
			const wait = teamDelay;
			teamDelay = 0;
			await sleep(wait);
			return real(...args);
		};
	}

	win = createMainWindow({ show: false, width: 1440, height: 900, webPreferences: { offscreen: true } });
	win.webContents.on('console-message', (event) => {
		if (event.level === 'error' || event.level === 'warning') consoleProblems.push(`${event.level}: ${event.message}`);
	});
	win.webContents.on('render-process-gone', (_event, details) => failures.push(`Renderer exited: ${details.reason}`));

	const js = (code) => win.webContents.executeJavaScript(code, true);
	const waitFor = async (expression, label, timeout = 5000) => {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (await js(`Boolean(${expression})`).catch(() => false)) return true;
			await sleep(50);
		}
		failures.push(`Timed out waiting for ${label}`);
		// Keep what the window looked like when the wait gave up.
		const name = `fail-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}`;
		fs.writeFileSync(path.join(artifacts, `${name}.png`), (await win.webContents.capturePage()).toPNG());
		return false;
	};
	const shot = async (name) => {
		await sleep(250);
		fs.writeFileSync(path.join(artifacts, `${name}.png`), (await win.webContents.capturePage()).toPNG());
		const audit = await js('window.__ui.audit()');
		check(audit.unnamed.length === 0, `${name}: controls without an accessible name: ${audit.unnamed.join(', ')}`);
		check(audit.small.length === 0, `${name}: controls under 24px: ${audit.small.join(', ')}`);
		check(!audit.overflow, `${name}: the page scrolls sideways`);
		check(!audit.buried, `${name}: notices are drawn over the open dialog`);
		check(!audit.offCentre, `${name}: the dialog is not in the middle of the window`);
	};
	const step = async (name, run) => {
		try {
			await run();
		} catch (error) {
			failures.push(`${name}: ${error.message}`);
		}
	};

	await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
	await js(HELPERS);
	await waitFor(`document.querySelector('.sidebar')`, 'the app to render');

	await step('overview', async () => {
		const stats = await js(`[...document.querySelectorAll('.stat__value')].map((el) => el.textContent)`);
		check(JSON.stringify(stats) === JSON.stringify(['10', '4', '1', '1']), `overview stats were ${JSON.stringify(stats)}`);
		const files = await js(`[...document.querySelectorAll('.nav-item--file .nav-item__label, .nav-item--nested .nav-item__label')].map((el) => el.textContent)`);
		check(JSON.stringify(files) === JSON.stringify(['_shared.yml', 'base.yml', 'broken.yml', 'dates.yml', 'Goodbyes', 'package.yml']), `sidebar listed ${JSON.stringify(files)}`);
		await shot('01-overview');
	});

	await step('file view', async () => {
		await js(`window.__ui.click('base.yml', '.nav-item__label')`);
		await waitFor(`document.querySelectorAll('.snippet-row').length === 3`, 'three snippets in base.yml');
		await shot('02-file');
	});

	await step('edit and save a snippet', async () => {
		stateDelay = 150;
		await js(`document.querySelector('.snippet-row__open').click()`);
		await waitFor(`document.querySelector('.editor textarea')?.value === 'Hello there'`, 'the editor to open on ;hello');
		await shot('03-editor');
		await js(`window.__ui.type('.editor textarea', 'Hello from the smoke test')`);
		await waitFor(`window.__ui.byText('Unsaved changes', '.badge')`, 'the unsaved badge');
		await js(`window.__ui.click('Save')`);
		await waitFor(`window.__ui.byText('Saved', '.action-bar__status')`, 'the save to finish');
		const text = onDisk('base.yml');
		check(text.includes('replace: "Hello from the smoke test"'), 'the edit did not reach base.yml');
		check(text.includes('# Simple hello') && text.includes('global_vars:') && text.includes('[";ty", ";thanks"]'), 'saving disturbed the rest of base.yml');
		const backups = fs.readdirSync(path.join(services.backupDir, 'local', 'base.yml'));
		check(backups.length === 1, `expected one backup of base.yml, found ${backups.length}`);
	});

	await step('add a snippet', async () => {
		await js(`window.__ui.click('New snippet')`);
		await waitFor(`document.querySelector('.editor input')?.value === ';'`, 'a new snippet starting with the file prefix');
		await js(`window.__ui.type('.editor input', ';smoke'); window.__ui.type('.editor textarea', 'Line one\\nLine two')`);
		await js(`window.__ui.click('Add snippet')`);
		await waitFor(`window.__ui.byText('Duplicate')`, 'the new snippet to open for editing');
		check(onDisk('base.yml').includes('  - trigger: ";smoke"\n    replace: |-\n      Line one\n      Line two\n'), 'the new snippet was not written as expected');
		stateDelay = 0;
	});

	await step('validation', async () => {
		await js(`window.__ui.type('.editor input', '')`);
		await js(`window.__ui.click('Save')`);
		await waitFor(`document.querySelector('.field__error')?.textContent === 'Add a trigger.'`, 'the missing-trigger message');
		check(onDisk('base.yml').includes('";smoke"'), 'an invalid snippet was saved');
		await js(`window.__ui.type('.editor input', ';smoke')`);
		await waitFor(`!document.querySelector('.field__error')`, 'the message to clear once the trigger is back');
	});

	await step('a double click on Save saves once', async () => {
		const backupsOf = () => fs.readdirSync(path.join(services.backupDir, 'local', 'base.yml')).length;
		const before = backupsOf();
		await js(`window.__ui.type('.editor textarea', 'Saved once')`);
		await waitFor(`window.__ui.byText('Unsaved changes', '.badge')`, 'the edit to register');
		await js(`{ const save = window.__ui.byText('Save'); save.click(); save.click(); } true;`);
		await waitFor(`window.__ui.byText('Saved', '.action-bar__status')`, 'the save to finish');
		await sleep(400);
		check(onDisk('base.yml').includes('Saved once'), 'the edit did not reach base.yml');
		check(backupsOf() === before + 1, `a double click on Save made ${backupsOf() - before} backups`);
		check(!(await js(`Boolean(window.__ui.byText('The file changed on disk', '.toast__title'))`)), 'a double click on Save raised a conflict');
	});

	await step('form snippet with variables', async () => {
		await js(`window.__ui.click('dates.yml', '.nav-item__label')`);
		await waitFor(`document.querySelectorAll('.snippet-row').length === 4`, 'four snippets in dates.yml');
		await js(`document.querySelectorAll('.snippet-row__open')[1].click()`);
		await waitFor(`document.querySelectorAll('.field-grid').length === 3`, 'the three form fields of :meet');
		await shot('04-editor-form');
	});

	await step('command palette opens a package snippet read-only', async () => {
		await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))`);
		await waitFor(`document.querySelector('.palette input')`, 'the palette');
		await js(`window.__ui.type('.palette input', 'bye')`);
		await waitFor(`document.querySelector('.palette__item')?.textContent.includes(':bye')`, 'a hit for :bye');
		await shot('05-palette');
		await js(`window.__ui.key('Enter')`);
		await waitFor(`document.querySelector('.alert__title')?.textContent === 'This snippet belongs to a package'`, 'the read-only notice');
		check(await js(`document.querySelector('.editor textarea').disabled`), 'a package snippet was editable');
		check(!(await js(`Boolean(window.__ui.byText('Save'))`)), 'a package snippet offered Save');
		await shot('06-package-snippet');
	});

	await step('broken file', async () => {
		await js(`window.__ui.click('broken.yml', '.nav-item__label')`);
		await waitFor(`document.querySelector('.raw-editor')?.value.includes(':oops')`, 'the raw editor for broken.yml');
		await shot('07-broken-file');
	});

	await step('all snippets and settings', async () => {
		await js(`window.__ui.click('All snippets', '.nav-item__label')`);
		await waitFor(`document.querySelectorAll('.snippet-row').length === 11`, 'eleven snippets listed');
		await js(`window.__ui.type('input[type=search]', 'thank')`);
		await waitFor(`document.querySelectorAll('.snippet-row').length === 2`, 'two snippets matching "thank"');
		await shot('08-search');
		await js(`window.__ui.click('Settings', '.nav-item__label')`);
		await waitFor(`document.querySelector('.copy-row code')?.textContent === ${JSON.stringify(matchDir)}`, 'the match folder path in Settings');
		await shot('09-settings');
	});

	await step('API listener', async () => {
		const address = `http://127.0.0.1:${apiPort}/api/v1`;
		const shown = `[...document.querySelectorAll('.copy-row code')].some((el) => el.textContent === '${address}')`;
		const reach = (headers) => fetch(`${address}/state`, { headers }).then((reply) => reply.status, () => 'closed');
		check((await reach()) === 'closed', 'the API was listening before it was switched on');

		await js(`document.querySelector('[role="switch"][aria-checked="false"]').click()`);
		await waitFor(shown, 'Settings to show the API address');
		await shot('09b-settings-api');

		const readToken = () => fs.readFileSync(path.join(app.getPath('userData'), 'api-token'), 'utf8').trim();
		let token = readToken();
		const seen = [token];
		check((await reach()) === 401, 'the API answered without a token');
		check((await reach({ Authorization: `Bearer ${token}`, Origin: 'https://example.com' })) === 403, 'the API answered a web page');
		const reply = await fetch(`${address}/state`, { headers: { Authorization: `Bearer ${token}` } });
		const state = await reply.json();
		check(reply.status === 200 && state.files.length === 4, `the API returned ${reply.status} with ${state.files?.length} files`);

		// Copying is done by the main process. The page asks, and hears back
		// only that it was done.
		await js(`window.__ui.click('Copy token')`);
		await waitFor(`window.__ui.byText('Token copied', '.toast__title')`, 'the token to be copied');
		check(copied.at(-1) === token, 'Copy token did not copy the token');
		await js(`window.__ui.click('Copy a curl example')`);
		await waitFor(`window.__ui.byText('Example copied', '.toast__title')`, 'the example to be copied');
		check(copied.at(-1) === `curl -H "Authorization: Bearer ${token}" ${address}/state`, `the example copied was ${copied.at(-1)}`);
		const told = [await js(`Promise.all(['token', 'curl'].map((what) => window.snippetEditor.invoke('listener:copy', what))).then(JSON.stringify)`)];
		check(told[0] === JSON.stringify([{ ok: true, data: true }, { ok: true, data: true }]), `asking for a copy answered ${told[0]}`);

		await js(`window.__ui.click('Replace token')`);
		await waitFor(`document.querySelector('.dialog')`, 'the question before replacing the token');
		await shot('09d-settings-api-replace');
		await js(`[...document.querySelectorAll('.dialog__foot button')].at(-1).click()`);
		await waitFor(`window.__ui.byText('Token replaced', '.toast__title')`, 'the token to be replaced');
		check(readToken() !== token, 'Replace token left the token as it was');
		check((await reach({ Authorization: `Bearer ${token}` })) === 401, 'the replaced token still worked');
		token = readToken();
		seen.push(token);
		told.push(await js(`Promise.all(['listener:get', 'listener:replaceToken'].map((channel) => window.snippetEditor.invoke(channel))).then(JSON.stringify)`));
		token = readToken();
		seen.push(token);
		told.push(await js(`window.snippetEditor.invoke('listener:set', { enabled: true, port: ${apiPort} }).then(JSON.stringify)`));
		check(new Set(seen).size === 3, 'replacing the token did not change it each time');
		check((await reach({ Authorization: `Bearer ${token}` })) === 200, 'the newest token did not work');
		const page = await js(`document.documentElement.outerHTML`);
		check(!seen.some((secret) => page.includes(secret)), 'a token is present in the page');
		check(!seen.some((secret) => told.join().includes(secret)), 'the main process told the page a token');

		// A port another program holds: Settings says so and the window carries on.
		const blocker = net.createServer();
		await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
		const busy = blocker.address().port;
		await js(`window.__ui.type('.setting__port input', '${busy}')`);
		await js(`window.__ui.click('Use this port')`);
		await waitFor(`document.querySelector('.alert__title')?.textContent === 'Port ${busy} is in use.'`, 'the port clash to be reported');
		await shot('09c-settings-api-port-in-use');
		await new Promise((resolve) => blocker.close(resolve));
		await js(`window.__ui.click('Try again')`);
		await waitFor(`[...document.querySelectorAll('.copy-row code')].some((el) => el.textContent === 'http://127.0.0.1:${busy}/api/v1')`, 'the API to start once the port is free');
		await js(`window.__ui.type('.setting__port input', '80')`);
		await waitFor(`document.querySelector('.field__error')?.textContent === 'Use a whole number from 1024 to 65535.'`, 'the port to be refused before it is sent');
		check(await js(`window.__ui.byText('Use this port').disabled`), 'a port outside the range could be sent');
		await js(`window.__ui.type('.setting__port input', '${apiPort}')`);
		await js(`window.__ui.click('Use this port')`);
		await waitFor(shown, 'the API to come back on its own port');

		await js(`document.querySelector('[role="switch"][aria-checked="true"]').click()`);
		await waitFor(`document.querySelector('[role="switch"][aria-checked="false"]') && !(${shown})`, 'Settings to show the API as off');
		check((await reach({ Authorization: `Bearer ${token}` })) === 'closed', 'the API kept listening after it was switched off');
	});

	await step('AI tools', async () => {
		const settingsFile = path.join(app.getPath('userData'), 'settings.json');
		const saved = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')).aiWrite;
		const toggle = `[...document.querySelectorAll('.switch-row')].find((row) => row.textContent.includes('Let AI tools change snippets'))?.querySelector('[role="switch"]')`;
		await waitFor(toggle, 'the AI tools switch');
		check((await js(`${toggle}.getAttribute('aria-checked')`)) === 'false' && saved() === false, 'AI tools could change snippets before that was switched on');

		await js(`${toggle}.click()`);
		await waitFor(`${toggle}.getAttribute('aria-checked') === 'true'`, 'the switch to turn on');
		check(saved() === true, 'switching it on did not reach the settings file');
		await js(`${toggle}.closest('.card').scrollIntoView({ block: 'center' }); true;`);
		await shot('09f-settings-ai');

		// The setup it offers is the one that starts the server, with no secret in it.
		await js(`window.__ui.click('Copy setup')`);
		await waitFor(`window.__ui.byText('Setup copied', '.toast__title')`, 'the setup to be copied');
		const setup = JSON.parse(copied.at(-1)).mcpServers['snippet-editor'];
		check(fs.existsSync(setup.args[0]) && setup.args[0].endsWith(path.join('mcp', 'server.mjs')), `the setup points at ${setup.args[0]}`);
		check(!copied.at(-1).includes(fs.readFileSync(path.join(app.getPath('userData'), 'api-token'), 'utf8').trim()), 'the setup carries the API token');

		// Started the way an AI tool would start it, it answers.
		const answer = await new Promise((resolve) => {
			const child = spawn(setup.command, setup.args, { env: { ...process.env, ...setup.env, SNIPPET_EDITOR_DATA_DIR: app.getPath('userData') }, stdio: ['pipe', 'pipe', 'ignore'] });
			let out = '';
			const giveUp = setTimeout(() => (child.kill(), resolve('no answer')), 10000);
			child.stdout.on('data', (chunk) => {
				out += chunk;
				if (!out.includes('\n')) return;
				clearTimeout(giveUp);
				child.stdin.end();
				resolve(out.split('\n')[0]);
			});
			child.on('error', (error) => resolve(`could not start: ${error.message}`));
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) + '\n');
		});
		check(answer.includes('"supportedVersions":["2026-07-28"]'), `the server started from the copied setup answered: ${answer.slice(0, 200)}`);

		// And it reaches the app: one real tool call, through the app's API.
		await backend.listener.set({ enabled: true, port: apiPort });
		const listed = await new Promise((resolve) => {
			const child = spawn(setup.command, setup.args, { env: { ...process.env, ...setup.env, SNIPPET_EDITOR_DATA_DIR: app.getPath('userData') }, stdio: ['pipe', 'pipe', 'ignore'] });
			let out = '';
			const giveUp = setTimeout(() => (child.kill(), resolve('no answer')), 15000);
			child.stdout.on('data', (chunk) => {
				out += chunk;
				if (out.split('\n').length < 3) return;
				clearTimeout(giveUp);
				child.stdin.end();
				resolve(out.split('\n')[1]);
			});
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }) + '\n');
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'snippets_list_files', arguments: { source: 'local' } } }) + '\n');
		});
		await backend.listener.set({ enabled: false, port: apiPort });
		check(listed.includes('"isError":false') && listed.includes('local:base.yml'), `a tool call through the copied setup answered: ${listed.slice(0, 300)}`);

		// Codex takes the same setup in its own format.
		await js(`window.__ui.click('TOML, for Codex', '[role=radio]')`);
		await js(`window.__ui.click('Copy setup')`);
		await waitFor(`document.querySelector('.code-block')?.textContent.startsWith('[mcp_servers.snippet-editor]')`, 'the Codex form of the setup');
		await sleep(150);
		check(copied.at(-1).startsWith('[mcp_servers.snippet-editor]\ncommand = ') && copied.at(-1).includes('ELECTRON_RUN_AS_NODE = "1"'), `the Codex setup copied was ${copied.at(-1).slice(0, 120)}`);

		await js(`${toggle}.click()`);
		await waitFor(`${toggle}.getAttribute('aria-checked') === 'false'`, 'the switch to turn off');
		check(saved() === false, 'switching it off did not reach the settings file');
	});

	await step('team snippets', async () => {
		const FIRST = 'acme/team-snippets';
		const SECOND = 'acme/support-snippets';
		const section = (label) => `[...document.querySelectorAll('.team-repo')].find((el) => el.querySelector('.section-title').textContent === ${JSON.stringify(label)})`;
		const sections = `[...document.querySelectorAll('.team-repo .section-title')].map((el) => el.textContent).join(' | ')`;
		const card = (label, title) => `[...(${section(label)}?.querySelectorAll('.team-card') ?? [])].find((el) => el.querySelector('h3').textContent === ${JSON.stringify(title)})`;
		const inCard = (label, title, button) => `[...(${card(label, title)}?.querySelectorAll('button') ?? [])].find((el) => el.textContent.trim() === ${JSON.stringify(button)})`;
		const badge = (label, title, text) => `[...(${card(label, title)}?.querySelectorAll('.badge') ?? [])].some((el) => el.textContent.trim() === ${JSON.stringify(text)})`;
		const inSection = (label, button) => `[...(${section(label)}?.querySelectorAll('.team-repo__head button') ?? [])].find((el) => el.textContent.trim() === ${JSON.stringify(button)})`;
		// The left-behind lists under the sections: each with its heading and its rows.
		const leftBehind = `JSON.stringify([...document.querySelectorAll('.team-left')].map((el) => [el.querySelector('.section-title').textContent, ...[...el.querySelectorAll('li')].map((row) => row.querySelector('code').textContent + ' ' + row.querySelector('.team-leftovers__from').textContent)]))`;
		// Settings: the addresses listed, and one repository's own buttons.
		const connected = `[...document.querySelectorAll('.team-repos .copy-row code')].map((el) => el.textContent).join(' | ')`;
		const inSettings = (address, button) =>
			`[...([...document.querySelectorAll('.team-repos > li')].find((el) => el.querySelector('.copy-row code').textContent === ${JSON.stringify(address)})?.querySelectorAll('button') ?? [])].find((el) => el.textContent.trim() === ${JSON.stringify(button)})`;
		const fieldLabel = `document.querySelector('.setting__team')?.closest('.field').querySelector('label').textContent`;
		const fieldError = `document.querySelector('.setting__team')?.closest('.field').querySelector('.field__error')?.textContent`;
		const teamFile = (...parts) => path.join(matchDir, 'team', ...parts);
		// Each thing this step waits for needs the one before it. When one does
		// not come, the step ends there: what follows would only wait in vain too.
		const need = async (expression, label, timeout) => {
			if (!(await waitFor(expression, label, timeout))) throw new Error(`gave up at "${label}"`);
		};
		const goTo = (label) => js(`window.__ui.click(${JSON.stringify(label)}, '.nav-item__label')`);
		const confirm = `[...document.querySelectorAll('.dialog__foot button')].at(-1)`;
		const proposalsIn = (repository) => repository.branches().filter((name) => name.startsWith('snippet-editor/'));
		const idOf = (address) => services.teams().find((team) => team.address.url === address)?.address.id;
		const saved = () => JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')).teamRepositories;
		// The page's buttons are off while one thing runs, as a person would
		// find them. Wait for the button to be ready, then press it.
		const press = async (button, label) => {
			await need(`(${button}) && !(${button}).disabled`, `${label} to be ready`);
			await js(`(${button}).click()`);
		};
		const theme = async (name) => {
			await js(`document.querySelector('.sidebar__footer [aria-label="${name}"]').click()`);
			await need(`document.documentElement.dataset.theme === '${name.toLowerCase()}'`, `the ${name.toLowerCase()} theme`);
		};
		// The team card is some way down Settings. It is brought to the top of
		// the pane, with a little room above it.
		const showTeamCard = () =>
			js(`{ const pane = document.querySelector('.content'); pane.scrollTop += document.querySelector('.setting__team, .team-repos').closest('.card').getBoundingClientRect().top - pane.getBoundingClientRect().top - 16; } true`);
		const toTop = () => js(`document.querySelector('.content').scrollTop = 0; true`);
		// Passing notices are let go before a picture, so that none covers what it is of.
		const picture = async (name, settle = async () => {}) => {
			await need(`document.querySelectorAll('.toast').length === 0`, `the notices to go before picturing ${name}`, 9000);
			await settle();
			await shot(`team-${name}`);
		};
		// One screen, pictured four ways: as it is, in the dark, and both again
		// in a narrow window.
		const pictures = async (name, settle = async () => {}) => {
			await picture(name, settle);
			try {
				await theme('Dark');
				await shot(`team-${name}-dark`);
				win.setContentSize(760, 560);
				await sleep(300);
				await settle();
				await shot(`team-${name}-760-dark`);
				await theme('Light');
				await shot(`team-${name}-760`);
			} finally {
				// The steps that follow expect the window as it was.
				await js(`document.querySelector('.sidebar__footer [aria-label="Light"]').click()`);
				win.setContentSize(1440, 900);
				await sleep(300);
			}
			await settle();
		};

		// --- one repository: as it was before there could be several ---

		// Connect, from Settings.
		await need(`document.querySelector('.setting__team input')`, 'the field for a repository address');
		check((await js(fieldLabel)) === 'Repository address', `with none connected the field is labelled: ${await js(fieldLabel)}`);
		await js(`window.__ui.type('.setting__team input', 'ext::sh -c "touch /tmp/owned"')`);
		await js(`window.__ui.click('Connect')`);
		await need(`${fieldError}?.startsWith('That is not a repository address.')`, 'a bad address to be refused in the field');
		await js(`window.__ui.type('.setting__team input', ${JSON.stringify(FIRST)})`);
		await js(`window.__ui.click('Connect')`);
		await need(`${connected} === ${JSON.stringify(TEAM.first)}`, 'Settings to show the connected repository');
		// Under the list, the field offers another, and is empty again.
		check((await js(fieldLabel)) === 'Connect another repository', `with one connected the field is labelled: ${await js(fieldLabel)}`);
		check((await js(`document.querySelector('.setting__team input').value`)) === '', 'the address stayed in the field after connecting');
		await picture('0a-settings-one', showTeamCard);

		// Browse and install.
		await goTo('Team packages');
		await need(`document.querySelectorAll('.team-card').length === 3`, 'three team packages');
		check((await js(sections)) === FIRST, `with one connected the sections are: ${await js(sections)}`);
		await picture('0b-page-one');
		await press(inCard(FIRST, 'Support replies', 'Install'), 'Install on the support package');
		await need(badge(FIRST, 'Support replies', 'Installed'), 'the support package to be installed');
		check(fs.readFileSync(teamFile('support', 'replies.yml'), 'utf8') === MATCHES([':refund', 'Your refund is on its way.']), 'the installed file is not the file in the repository');
		await need(`window.__ui.byText('Support replies', '.nav-item__label')`, 'the package in the sidebar');
		await goTo('escalations.yml');
		await need(`document.querySelectorAll('.snippet-row').length === 3`, 'the three snippets of a team file');
		check(!(await js(`Boolean(window.__ui.byText('New snippet', '.page-head__actions button'))`)), 'a team file offered New snippet');
		await js(`document.querySelector('.snippet-row__open').click()`);
		await need(`document.querySelector('.alert__title')?.textContent === 'This snippet belongs to a team package'`, 'the read-only notice for a team snippet');
		check(await js(`document.querySelector('.editor textarea').disabled`), 'a team snippet was editable');
		await picture('0c-team-snippet');

		// A package that runs commands asks first.
		await goTo('Team packages');
		await need(badge(FIRST, 'Tools', 'Runs commands'), 'the warning on a package that runs commands');
		await press(inCard(FIRST, 'Tools', 'Install'), 'Install on the tools package');
		await need(`document.querySelector('.dialog h2')?.textContent === 'This package runs commands'`, 'the question before installing it');
		await picture('0d-runs-commands');
		check(!fs.existsSync(teamFile('tools')), 'the package was installed before the answer');
		await js(`${confirm}.click()`);
		await need(badge(FIRST, 'Tools', 'Installed'), 'the package to be installed once accepted');

		// A change in the repository shows as an update, for that package only.
		remote.commit({ 'packages/support/replies.yml': MATCHES([':refund', 'Refund sent today.']) });
		await press(inSection(FIRST, 'Check for updates'), 'Check for updates');
		await need(badge(FIRST, 'Support replies', 'Update available'), 'the update notice');
		check(!(await js(badge(FIRST, 'Tools', 'Update available'))), 'an unchanged package was marked for update');
		await picture('0e-update');
		await press(inCard(FIRST, 'Support replies', 'Update'), 'Update on the support package');
		await need(`!(${badge(FIRST, 'Support replies', 'Update available')})`, 'the update to finish');
		check(fs.readFileSync(teamFile('support', 'replies.yml'), 'utf8') === MATCHES([':refund', 'Refund sent today.']), 'the update did not reach the installed file');

		// Remove, with a question first.
		await press(inCard(FIRST, 'Tools', 'Remove'), 'Remove on the tools package');
		await need(`document.querySelector('.dialog h2')?.textContent === 'Remove Tools?'`, 'the question before removing');
		await js(`${confirm}.click()`);
		await need(`${inCard(FIRST, 'Tools', 'Install')}`, 'the package to be removed');
		check(!fs.existsSync(teamFile('tools')), 'the removed package is still on disk');

		// With one connected, a proposal is not asked where it goes.
		await goTo('dates.yml');
		await need(`window.__ui.byText('Propose to team')`, 'the Propose button on a local file');
		await js(`window.__ui.click('Propose to team')`);
		await need(`document.querySelector('.dialog select[name=target]') && !document.querySelector('.dialog select[name=target]').disabled`, 'the proposal dialog');
		check(!(await js(`Boolean(document.querySelector('.dialog select[name=repository]'))`)), 'with one repository connected the dialog asked which');
		check(await js(`document.querySelector('.dialog__head p').textContent.includes(${JSON.stringify(TEAM.first)})`), 'the dialog does not say where the file would go');
		await js(`window.__ui.click('Cancel')`);

		// --- a second repository ---

		// The other form of the address that is connected is the same repository.
		await goTo('Settings');
		await need(`${connected} === ${JSON.stringify(TEAM.first)}`, 'Settings again');
		await js(`window.__ui.type('.setting__team input', 'git@github.com:acme/team-snippets.git')`);
		await js(`window.__ui.click('Connect')`);
		await need(`${fieldError} === ${JSON.stringify(`This repository is already connected, as ${TEAM.first}.`)}`, 'the other form of a connected address to be refused in the field');
		// Connecting takes a while, and the page is left meanwhile. The work
		// finishes in the background, and what is open then shows it.
		teamDelay = 2500;
		await js(`window.__ui.type('.setting__team input', ${JSON.stringify(TEAM.second)})`);
		await js(`window.__ui.click('Connect')`);
		await need(`window.__ui.byText('Connecting…')`, 'the button to say it is connecting');
		await goTo('Team packages');
		await need(`${sections} === ${JSON.stringify(FIRST)}`, 'the Team page while the second repository is still connecting');
		await need(`${sections} === ${JSON.stringify(`${FIRST} | ${SECOND}`)}`, 'the second section to arrive once it is connected, with nothing pressed', 15000);
		check(await js(`document.querySelectorAll('.team-card').length === 5`), 'the two sections do not hold five packages between them');
		// Back in Settings, the result is there.
		await goTo('Settings');
		await need(`${connected} === ${JSON.stringify(`${TEAM.first} | ${TEAM.second}`)}`, 'Settings to list both repositories');
		check(JSON.stringify(saved()) === JSON.stringify([TEAM.first, TEAM.second]), `the settings file holds ${JSON.stringify(saved())}`);
		await pictures('1-settings-two', showTeamCard);

		// Checking one for updates leaves the other as it was.
		const before = services.teams().map((team) => team.address.id);
		second.commit({ 'packages/shipping/package.yml': MATCHES([':sent', 'Your parcel is on its way.'], [':late', 'Your parcel is late.'], [':lost', 'We are looking for your parcel.']) });
		await press(inSettings(TEAM.second, 'Check for updates'), 'Check for updates on the second repository');
		await need(`window.__ui.byText('Checked for updates', '.toast__title')`, 'the check to finish');
		check(JSON.stringify(services.teams().map((team) => team.address.id)) === JSON.stringify(before), 'checking for updates changed which repositories are connected');

		// One of the two cannot be reached. Its own section says so and still
		// lists what it had. The other is as it was.
		await goTo('Team packages');
		await need(`${sections} === ${JSON.stringify(`${FIRST} | ${SECOND}`)}`, 'both sections');
		check(await js(`${card(SECOND, 'Shipping')}.querySelector('.team-card__meta').textContent.includes('3 snippets')`), 'the check from Settings did not reach the Team page');
		const unreached = (where) => `[...(${where}?.querySelectorAll('.alert') ?? [])].map((el) => el.querySelector('.alert__title').textContent + ': ' + (el.querySelector('p')?.textContent ?? '').slice(0, 36)).join(' | ')`;
		fs.renameSync(second.url, `${second.url}.away`);
		await press(inSection(SECOND, 'Check for updates'), 'Check for updates on a repository that has gone');
		await need(`${unreached(section(SECOND))} === 'The repository could not be reached: Git could not reach that repository.'`, 'the section of a repository out of reach to say so');
		check((await js(unreached(section(FIRST)))) === '', `the other section carries a problem too: ${await js(unreached(section(FIRST)))}`);
		check(await js(`${section(SECOND)}.querySelectorAll('.team-card').length === 2 && ${section(FIRST)}.querySelectorAll('.team-card').length === 3`), 'a repository out of reach no longer lists what it had');
		await picture('1b-page-out-of-reach', toTop);
		// Settings says it on that repository's own entry.
		await goTo('Settings');
		const entry = (address) => `[...document.querySelectorAll('.team-repos > li')].find((el) => el.querySelector('.copy-row code').textContent === ${JSON.stringify(address)})`;
		await need(`${unreached(entry(TEAM.second))} === 'The repository could not be reached: Git could not reach that repository.'`, 'Settings to say which repository is out of reach');
		check((await js(unreached(entry(TEAM.first)))) === '', 'Settings marks the other repository as out of reach too');
		await picture('1c-settings-out-of-reach', showTeamCard);
		// Back in reach, a check clears it.
		fs.renameSync(`${second.url}.away`, second.url);
		await press(inSettings(TEAM.second, 'Check for updates'), 'Check for updates once the repository is back');
		await need(`${unreached(entry(TEAM.second))} === ''`, 'the problem to clear once the repository is back');

		// One package from each. The second's goodbyes takes the name, so the
		// first's cannot be installed, and says where the name is held.
		await goTo('Team packages');
		await need(`${sections} === ${JSON.stringify(`${FIRST} | ${SECOND}`)}`, 'both sections again');
		check((await js(unreached(section(SECOND)))) === '', 'the section still says its repository is out of reach');
		await press(inCard(SECOND, 'Goodbyes', 'Install'), 'Install on the second repository\'s goodbyes');
		await need(badge(SECOND, 'Goodbyes', 'Installed'), 'the second repository\'s goodbyes to be installed');
		check(fs.readFileSync(teamFile('goodbyes', 'package.yml'), 'utf8') === MATCHES([':later', 'See you later']), 'the package installed is not the second repository\'s');
		const held = `${card(FIRST, 'Goodbyes')}.querySelector('.team-card__held')`;
		await need(`${held}?.textContent.trim() === ${JSON.stringify(`Installed from ${SECOND}. Remove it first, then install this one.`)}`, 'the first repository\'s goodbyes to say where the name is held');
		check(await js(`${inCard(FIRST, 'Goodbyes', 'Install')}.disabled`), 'Install is on for a package whose name another repository holds');
		check(await js(`${inCard(FIRST, 'Goodbyes', 'Install')}.getAttribute('aria-describedby') === ${held}.id && ${held}.id !== ''`), 'the Install that is off does not give its reason as its description');
		check(!(await js(badge(FIRST, 'Goodbyes', 'Installed'))) && !(await js(badge(FIRST, 'Goodbyes', 'Update available'))), 'a package held by another repository shows as installed or as having an update');
		check(await js(badge(FIRST, 'Support replies', 'Installed')), 'the first repository\'s own package no longer shows as installed');
		await pictures('2-page-clash', toTop);

		// --- a proposal says which repository it is for ---

		await goTo('dates.yml');
		await need(`window.__ui.byText('Propose to team')`, 'the Propose button with two connected');
		await js(`window.__ui.click('Propose to team')`);
		const which = `document.querySelector('.dialog select[name=repository]')`;
		const target = `document.querySelector('.dialog select[name=target]')`;
		const offered = (select) => `[...${select}.options].map((option) => option.textContent).join(' | ')`;
		await need(which, 'the repository choice in the proposal dialog');
		check((await js(offered(which))) === `Choose a repository… | ${FIRST} | ${SECOND}`, `the repositories offered were: ${await js(offered(which))}`);
		// Where a file goes is not chosen for you.
		check(await js(`${which}.value === '' && ${target}.disabled && window.__ui.byText('Send proposal').disabled`), 'a proposal could be sent before its repository was chosen');
		check(await js(`[...document.querySelectorAll('.dialog label')].map((el) => el.textContent).indexOf('Repository') === 0`), 'the dialog does not start with the repository');
		await picture('3a-propose-choose');
		// The packages follow the repository.
		await js(`window.__ui.choose('.dialog select[name=repository]', ${JSON.stringify(idOf(TEAM.first))})`);
		await need(`${offered(target)} === 'Goodbyes | Support replies | Tools | A new package'`, 'the first repository\'s packages in the dialog');
		await js(`window.__ui.choose('.dialog select[name=repository]', ${JSON.stringify(idOf(TEAM.second))})`);
		await need(`${offered(target)} === 'Goodbyes | Shipping | A new package'`, 'the second repository\'s packages in the dialog');
		check(await js(`document.querySelector('.dialog__head p').textContent.includes(${JSON.stringify(TEAM.second)})`), 'the dialog does not say which repository the file would go to');
		await js(`window.__ui.type('.dialog input[name=summary]', 'Share the date snippets')`);
		await pictures('3b-propose-repository');
		await js(`{ const send = window.__ui.byText('Send proposal'); send.click(); send.click(); } true;`);
		await need(`document.querySelector('.dialog h2')?.textContent === 'Proposal sent'`, 'the proposal to be sent', 15000);
		const proposals = proposalsIn(second);
		check(proposals.length === 1, `a double click on Send made ${proposals.length} branches in the second repository`);
		check(proposalsIn(remote).length === 0, `the proposal reached the first repository too: ${proposalsIn(remote).join(', ')}`);
		check(second.show(proposals[0], 'packages/goodbyes/dates.yml') + '\n' === onDisk('dates.yml'), 'the proposed file is not the file on disk');
		check(await js(`document.querySelector('.dialog code')?.textContent === ${JSON.stringify(proposals[0])}`), 'the dialog does not name the branch');
		check(await js(`document.querySelector('.dialog__body p').textContent.includes(${JSON.stringify(SECOND)})`), 'the dialog does not say which repository the branch is in');
		await shot('team-3c-proposal-sent');
		await js(`window.__ui.click('Open pull request page')`);
		await sleep(200);
		const pullRequest = `https://github.com/${SECOND}/compare/main...${proposals[0]}?expand=1`;
		check(opened.length === 1 && opened[0] === pullRequest, `the pull request page opened was ${JSON.stringify(opened)}`);
		await js(`window.__ui.click('Close')`);

		// A link inside either connected repository opens. One inside neither does not.
		const openLink = async (link) => JSON.parse(await js(`window.snippetEditor.invoke('team:openLink', ${JSON.stringify(link)}).then(JSON.stringify)`));
		const inFirst = `https://github.com/${FIRST}/tree/main/packages/support`;
		check((await openLink(inFirst)).ok === true && opened.at(-1) === inFirst, 'a link inside the first connected repository was not opened');
		for (const link of ['https://evil.example/acme/support-snippets/compare/main...x', 'https://github.com/acme/other/compare/main...x', `https://github.com/${SECOND}-evil/compare/main...x`, 'file:///etc/hosts']) {
			const refused = await openLink(link);
			check(refused.ok === false && refused.error.message === 'That link is not part of a connected repository.' && opened.length === 2, `a link elsewhere was opened: ${link} ${JSON.stringify(refused)}`);
		}

		// --- the first repository is disconnected ---

		await goTo('Settings');
		await need(`${connected} === ${JSON.stringify(`${TEAM.first} | ${TEAM.second}`)}`, 'Settings before disconnecting');
		await press(inSettings(TEAM.first, 'Disconnect'), 'Disconnect on the first repository');
		await need(`document.querySelector('.dialog h2')?.textContent === ${JSON.stringify(`Disconnect ${FIRST}?`)}`, 'the question that names the repository to disconnect');
		// It takes a while, and the Team page is opened meanwhile. Its section
		// goes when the repository does, with nothing pressed on that page.
		teamDelay = 2500;
		await js(`${confirm}.click()`);
		await goTo('Team packages');
		await need(`${sections} === ${JSON.stringify(`${FIRST} | ${SECOND}`)}`, 'the Team page while the first repository is still being disconnected');
		await need(`${sections} === ${JSON.stringify(SECOND)}`, 'the first section to go once its repository is disconnected', 15000);
		// What was installed from it stays installed, and is listed apart with its address.
		const apart = JSON.stringify([['From repositories that are not connected (1)', `support ${TEAM.first}`]]);
		await need(`${leftBehind} === ${JSON.stringify(apart)}`, 'the first repository\'s package to be listed apart');
		check(fs.existsSync(teamFile('support', 'replies.yml')) && fs.existsSync(teamFile('goodbyes', 'package.yml')), 'disconnecting removed an installed package');
		check(JSON.stringify(saved()) === JSON.stringify([TEAM.second]), `after the disconnect the settings file holds ${JSON.stringify(saved())}`);
		check(fs.readdirSync(path.join(app.getPath('userData'), 'team')).length === 1, 'the copy of the disconnected repository is still there');
		check(await js(badge(SECOND, 'Goodbyes', 'Installed')), 'the other repository\'s package no longer shows as installed');
		await pictures('4-after-disconnect', toTop);
		// Its links open no more. The other's still do.
		const gone = await openLink(inFirst);
		check(gone.ok === false && opened.length === 2, `a link for a repository disconnected since was opened: ${JSON.stringify(gone)}`);
		check((await openLink(pullRequest)).ok === true && opened.length === 3, 'a link for the repository still connected stopped opening');
		// In Settings one is listed, and the field under it offers another.
		await goTo('Settings');
		await need(`${connected} === ${JSON.stringify(TEAM.second)}`, 'Settings to list the one repository left');
		check((await js(fieldLabel)) === 'Connect another repository', 'after a disconnect the field no longer offers another repository');

		// --- what a connected repository drops is listed apart too ---

		await goTo('Team packages');
		await press(inCard(SECOND, 'Shipping', 'Install'), 'Install on the shipping package');
		await need(badge(SECOND, 'Shipping', 'Installed'), 'the shipping package to be installed');
		second.commit({ 'packages/shipping/_manifest.yml': null, 'packages/shipping/package.yml': null });
		await press(inSection(SECOND, 'Check for updates'), 'Check for updates after the package was dropped');
		const both = JSON.stringify([
			['Installed, but no longer in the repository (1)', `shipping ${SECOND}`],
			['From repositories that are not connected (1)', `support ${TEAM.first}`],
		]);
		await need(`${leftBehind} === ${JSON.stringify(both)}`, 'the dropped package and the left-behind package, each in its list');
		await picture('5-left-behind', toTop);
		// Each can still be removed.
		await press(`[...document.querySelectorAll('.team-left li')].find((row) => row.querySelector('code').textContent === 'shipping')?.querySelector('button')`, 'Remove on the dropped package');
		await need(`document.querySelector('.dialog h2')?.textContent === 'Remove shipping?'`, 'the question before removing a dropped package');
		await js(`${confirm}.click()`);
		await need(`${leftBehind} === ${JSON.stringify(apart)}`, 'the dropped package to be removed');
		check(!fs.existsSync(teamFile('shipping')), 'the removed package is still on disk');

		// --- ten repositories, which is the most ---

		const kits = [];
		for (let number = 2; number <= 10; number += 1) {
			const kit = createRemote(path.join(sandbox, `team-kit-${number}`));
			kit.commit(Object.fromEntries(['notes', 'replies', 'sign-offs'].flatMap((name) => [[`packages/${name}-${number}/_manifest.yml`, MANIFEST(`${name}-${number}`)], [`packages/${name}-${number}/package.yml`, MATCHES([`:${name}${number}`, `From kit ${number}`])]])));
			folders.set(`https://github.com/acme/kit-${number}.git`, kit.url);
			kits.push(`acme/kit-${number}`);
		}
		for (const address of kits) await services.connectTeam(address);
		check(services.teams().length === 10, `${services.teams().length} repositories are connected, not ten`);
		await goTo('Overview');
		await goTo('Team packages');
		await need(`document.querySelectorAll('.team-repo').length === 10`, 'ten sections, one under another', 15000);
		check((await js(sections)) === [SECOND, ...kits].join(' | '), `the ten sections are: ${await js(sections)}`);
		check(await js(`document.querySelectorAll('.team-card').length === 28`), `ten repositories listed ${await js(`document.querySelectorAll('.team-card').length`)} packages, not 28`);
		check(await js(`document.querySelector('.content').scrollHeight > document.querySelector('.content').clientHeight * 2`), 'ten sections do not make a page that scrolls');
		await picture('6a-page-ten', toTop);
		// The last section is as usable as the first.
		await js(`${section('acme/kit-10')}.scrollIntoView(); true`);
		await press(inCard('acme/kit-10', 'Notes-10', 'Install'), 'Install in the tenth section');
		await need(badge('acme/kit-10', 'Notes-10', 'Installed'), 'a package of the tenth repository to be installed');
		// With ten connected, Settings lists them all and offers no eleventh.
		await goTo('Settings');
		await need(`document.querySelectorAll('.team-repos > li').length === 10`, 'Settings to list ten repositories');
		check(!(await js(`Boolean(document.querySelector('.setting__team'))`)), 'with ten connected the field for another is still shown');
		check(await js(`[...document.querySelectorAll('.card .field__help')].some((el) => el.textContent.trim() === 'Ten repositories are connected, which is the most. Disconnect one to connect another.')`), 'with ten connected nothing says why no other can be added');
		await picture('6b-settings-ten', showTeamCard);
		// Back to the one, as the steps that follow expect.
		await goTo('Team packages');
		await press(inCard('acme/kit-10', 'Notes-10', 'Remove'), 'Remove in the tenth section');
		await need(`document.querySelector('.dialog h2')?.textContent === 'Remove Notes-10?'`, 'the question before removing in the tenth section');
		await js(`${confirm}.click()`);
		await need(`${inCard('acme/kit-10', 'Notes-10', 'Install')}`, 'the tenth repository\'s package to be removed');
		for (const team of services.teams().slice(1)) await services.disconnectTeam(team.address.id);
		check(JSON.stringify(saved()) === JSON.stringify([TEAM.second]), `at the end of the team step the settings file holds ${JSON.stringify(saved())}`);
		await goTo('Overview');
	});

	await step('external change is picked up', async () => {
		fs.appendFileSync(path.join(matchDir, 'dates.yml'), '\n  - trigger: ":ext"\n    replace: "from outside"\n');
		await waitFor(`[...document.querySelectorAll('.nav-item--file')].find((el) => el.textContent.includes('dates.yml'))?.querySelector('.nav-count')?.textContent === '5'`, 'the sidebar count to follow the file');
	});

	await step('dark theme', async () => {
		await js(`document.querySelector('.sidebar__footer [aria-label="Dark"]').click()`);
		await waitFor(`document.documentElement.dataset.theme === 'dark'`, 'the dark theme');
		await js(`window.__ui.click('Overview', '.nav-item__label')`);
		await waitFor(`document.querySelector('.stats')`, 'the overview');
		await shot('10-overview-dark');
		await js(`window.__ui.click('base.yml', '.nav-item__label')`);
		await waitFor(`document.querySelectorAll('.snippet-row').length === 4`, 'base.yml in dark');
		await js(`document.querySelectorAll('.snippet-row__open')[1].click()`);
		await waitFor(`document.querySelector('.editor')`, 'the editor in dark');
		await shot('11-editor-dark');
		await js(`document.querySelector('.sidebar__footer [aria-label="Light"]').click()`);
	});

	for (const [label, width, height] of [
		['1024', 1024, 720],
		['760', 760, 560],
	]) {
		await step(`window at ${label}px`, async () => {
			win.setContentSize(width, height);
			await sleep(300);
			await shot(`12-editor-${label}`);
			if (width <= 900) {
				await js(`document.querySelector('.topbar [aria-label="Show the sidebar"]').click()`);
				await waitFor(`getComputedStyle(document.querySelector('.sidebar')).display !== 'none'`, 'the sidebar drawer');
				await shot(`13-drawer-${label}`);
				await js(`document.querySelector('.sidebar-scrim').click()`);
			}
			await js(`document.querySelector('.crumbs__link').click()`);
			await waitFor(`document.querySelector('.snippet-list')`, 'the file view');
			await shot(`14-file-${label}`);
			await js(`document.querySelector('.snippet-row__open').click()`);
			await waitFor(`document.querySelector('.editor')`, 'the editor again');
		});
	}

	await step('settings in a narrow window', async () => {
		await js(`document.querySelector('.topbar [aria-label="Show the sidebar"]').click()`);
		await waitFor(`getComputedStyle(document.querySelector('.sidebar')).display !== 'none'`, 'the sidebar drawer');
		await js(`window.__ui.click('Settings', '.nav-item__label')`);
		await waitFor(`document.querySelector('.copy-row code')`, 'Settings in a narrow window');
		await js(`document.querySelector('.sidebar-scrim')?.click()`);
		await shot('16-settings-760');
	});

	await step('hostile content', async () => {
		win.setContentSize(1440, 900);
		fs.writeFileSync(
			path.join(matchDir, 'hostile.yml'),
			[
				'matches:',
				'  - trigger:',
				'      toString: 1',
				'    replace: "object trigger"',
				'  - trigger: ":odd"',
				'    label:',
				'      toString: 1',
				'    replace:',
				'      toString: 1',
				'    vars:',
				'      - name:',
				'          toString: 1',
				'        type: constructor',
				'      - plain text',
				'  - trigger: ":ctor"',
				'    replace: "x"',
				'    vars:',
				'      - name: v',
				'        type: constructor',
				'        params:',
				'          x: 1',
				'',
			].join('\n')
		);
		fs.writeFileSync(path.join(matchDir, 'alias.yml'), 'matches:\n  - trigger: ":a"\n    replace: *missing\n');
		await waitFor(`window.__ui.byText('hostile.yml', '.nav-item__label') && window.__ui.byText('alias.yml', '.nav-item__label')`, 'the hostile files to be listed');
		await js(`window.__ui.click('All snippets', '.nav-item__label')`);
		await waitFor(`document.querySelectorAll('.snippet-row').length >= 14`, 'All snippets to list the hostile snippets');
		await js(`window.__ui.type('input[type=search]', 'object')`);
		await waitFor(`document.querySelectorAll('.snippet-row').length === 1`, 'search to find the hostile snippet');
		await js(`window.__ui.click('hostile.yml', '.nav-item__label')`);
		await waitFor(`document.querySelectorAll('.snippet-row').length === 3`, 'hostile.yml to list three snippets');
		for (const index of [0, 1, 2]) {
			await js(`document.querySelectorAll('.snippet-row__open')[${index}].click()`);
			await waitFor(`document.querySelector('.editor')`, `the editor to open hostile snippet ${index + 1}`);
			await shot(`15-hostile-${index + 1}`);
			await js(`document.querySelector('.crumbs__link').click()`);
			await waitFor(`document.querySelector('.snippet-list')`, 'hostile.yml again');
		}
		await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))`);
		await waitFor(`document.querySelector('.palette input')`, 'the palette');
		await js(`window.__ui.type('.palette input', 'odd')`);
		await waitFor(`document.querySelector('.palette__item')?.textContent.includes(':odd')`, 'the palette to find :odd');
		await js(`window.__ui.key('Escape')`);
		await js(`window.__ui.click('alias.yml', '.nav-item__label')`);
		await waitFor(`document.querySelector('.raw-editor')?.value.includes('*missing')`, 'the raw editor for the file with a broken alias');
		check(await js(`Boolean(document.querySelector('.sidebar'))`), 'the window went blank on hostile content');
	});

	// The stand-in agent is a script started by its first line, which Windows cannot do.
	if (process.platform !== 'win32') {
		await step('assistant', async () => {
			const inChat = (label) => `[...document.querySelectorAll('.chat button')].find((el) => (el.getAttribute('aria-label') ?? el.textContent.trim()) === ${JSON.stringify(label)})`;
			const ask = async (text) => {
				await js(`window.__ui.type('.chat__box', ${JSON.stringify(text)})`);
				await waitFor(`${inChat('Send')} && !${inChat('Send')}.disabled`, 'Send to be ready');
				await js(`${inChat('Send')}.click()`);
			};
			const answered = (count) => waitFor(`!document.querySelector('.chat__working') && document.querySelectorAll('.msg--assistant').length === ${count}`, `answer ${count} to end`, 20000);
			const lastAnswer = `[...document.querySelectorAll('.msg--assistant')].at(-1)`;
			const pending = `[...document.querySelectorAll('.proposal[data-status="pending"] .btn')].find((el) => el.textContent.trim() === 'Apply')`;

			// Nothing is ready: the panel says what each backend needs, and no message can be written.
			await js(`window.__ui.click('Overview', '.nav-item__label')`);
			await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true }))`);
			await waitFor(`document.querySelector('.chat:not([hidden]) .backends')`, 'the list of backends when none is ready');
			check(await js(`document.querySelector('.chat__box').disabled`), 'a message could be written with no backend ready');
			check(
				JSON.stringify(await js(`[...document.querySelectorAll('.backend')].map((el) => [el.querySelector('.backend__name').textContent, el.querySelector('.badge').textContent.trim()])`)) ===
					JSON.stringify([['Claude Code', 'Not installed'], ['Codex', 'Not signed in'], ['Ollama', 'Not running']]),
				'the backends were not listed with their states'
			);
			await js(`${inChat('Copy')}.click()`);
			await sleep(150);
			check(copied.at(-1) === '/opt/tools/codex login', `the sign-in command copied was ${copied.at(-1)}`);
			await shot('19-assistant-setup');

			// One becomes ready.
			chatReady.codex = true;
			await js(`${inChat('Check again')}.click()`);
			await waitFor(`document.querySelector('.chat__starter')`, 'the starters once a backend is ready');
			check(await js(`document.querySelector('.chat__notice')?.textContent.includes('Codex sends your messages, the snippets that match them, what you have open, and the snippets it reads, to OpenAI')`), 'nothing said where the text goes');
			// Until that has been read, nothing can be sent.
			await js(`window.__ui.type('.chat__box', 'Sent before the notice was read')`);
			await sleep(100);
			check(await js(`${inChat('Send')}.disabled`), 'a message could be sent before the notice was read');
			await js(`document.querySelector('.chat__box').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
			await sleep(150);
			check(!(await js(`Boolean(document.querySelector('.msg'))`)), 'Enter sent a message before the notice was read');
			await js(`window.__ui.type('.chat__box', '')`);
			await js(`${inChat('OK')}.click()`);
			await waitFor(`!document.querySelector('.chat__notice')`, 'the notice to go once read');
			check((await js(`document.querySelector('.chat__provider').textContent`)) === 'Codex', 'the footer does not name who answers');
			await shot('19b-assistant-empty');

			// A question, an answer, a card. Nothing is written.
			const before = onDisk('base.yml');
			await ask('SAY Here is a draft.\nADD ;asst=From the assistant\nSAY It is waiting on the card.');
			await answered(1);
			check((await js(`${lastAnswer}.querySelector('.msg__tools').textContent`)) === 'Read a file · Proposed a snippet', `the tool line read: ${await js(`${lastAnswer}.querySelector('.msg__tools')?.textContent`)}`);
			check(
				JSON.stringify(await js(`[...${lastAnswer}.children].map((el) => el.className.split(' ')[0])`)) === JSON.stringify(['msg__tools', 'md', 'proposal', 'md']),
				'the card is not where the assistant proposed it'
			);
			check((await js(`document.querySelector('.proposal__title').textContent`)) === 'Add a snippet to base.yml', 'the card does not say what it would do');
			check(await js(`[...document.querySelectorAll('.diff-row--add .diff-row__text')].map((el) => el.textContent).join('|') === '- trigger: ";asst"|  replace: "From the assistant"'`), 'the card does not show the snippet');
			check(onDisk('base.yml') === before, 'the assistant changed a file without Apply');
			await shot('19c-assistant-card');

			// The switch is off: Apply says so, and writes nothing.
			await js(`${pending}.click()`);
			await waitFor(`document.querySelector('.proposal__problem')?.textContent.startsWith('Changes by AI tools are switched off.')`, 'Apply to say the switch is off');
			check(await js(`Boolean(${inChat('Open Settings')})`), 'no way to the switch was offered');
			check(onDisk('base.yml') === before, 'Apply wrote with the switch off');

			// Switched on, Apply writes it.
			await backend.service.saveSettings({ aiWrite: true });
			await js(`${pending}.click()`);
			await waitFor(`document.querySelector('.proposal[data-status="applied"]')`, 'the card to be applied');
			check(onDisk('base.yml') === `${before}\n  - trigger: ";asst"\n    replace: "From the assistant"\n`, 'Apply did not write the snippet as shown');
			await shot('19d-assistant-applied');
			await js(`${inChat('Show the file')}.click()`);
			await waitFor(`[...document.querySelectorAll('.snippet-row')].some((el) => el.textContent.includes(';asst'))`, 'the file to open with the new snippet');

			// Unsaved edits to the same file hold Apply back.
			await ask('ADD ;held=Held back');
			await answered(2);
			await js(`document.querySelector('.snippet-row__open').click()`);
			await waitFor(`document.querySelector('.editor textarea')`, 'the editor');
			await js(`window.__ui.type('.editor textarea', 'Edited while a card waits')`);
			await waitFor(`window.__ui.byText('Unsaved changes', '.badge')`, 'the unsaved badge');
			await js(`${pending}.click()`);
			await waitFor(`document.querySelector('.proposal__problem')?.textContent === 'Save or discard your edits to this file first.'`, 'Apply to wait for the edits');
			check(!onDisk('base.yml').includes(';held'), 'Apply wrote over unsaved edits');
			await js(`window.__ui.click('Save')`);
			await waitFor(`window.__ui.byText('Saved', '.action-bar__status')`, 'the save to finish');
			await js(`${pending}.click()`);
			await waitFor(`document.querySelectorAll('.proposal[data-status="applied"]').length === 2`, 'the second card to be applied after the save');
			check(onDisk('base.yml').includes('Edited while a card waits') && onDisk('base.yml').includes('  - trigger: ";held"\n    replace: "Held back"\n'), 'the saved edit and the applied card are not both in the file');

			// Three cards in one answer: every row of each is on its card, a
			// command says so, one is dismissed and the other two applied at once.
			await ask('BIG 450\nCOMMAND :ip\nADD ;third=Third');
			await answered(3);
			const cardsOf = `[...${lastAnswer}.querySelectorAll('.proposal')]`;
			check((await js(`${cardsOf}.length`)) === 3, 'three cards were not shown for three changes');
			const bigRows = await js(`[...${cardsOf}[0].querySelectorAll('.diff-row--add .diff-row__text')].map((el) => el.textContent)`);
			check(bigRows.length === 452 && bigRows.at(-1).trim() === 'Line 450 of 450', `a long change is not all on its card: ${bigRows.length} rows, ending ${JSON.stringify(bigRows.at(-1))}`);
			check((await js(`${cardsOf}[0].querySelector('.proposal__count').textContent`)) === '452 lines added', 'the card does not say how much it would add');
			check((await js(`${cardsOf}[1].querySelector('.proposal__warning')?.textContent.trim()`)) === 'Runs a command on your computer each time it is used.', 'a snippet that runs a command carried no warning');
			await shot('19j-assistant-three-cards');
			const beforeThree = onDisk('base.yml');
			await js(`[...${cardsOf}[1].querySelectorAll('.btn')].find((el) => el.textContent.trim() === 'Dismiss').click()`);
			await waitFor(`${cardsOf}[1].dataset.status === 'dismissed'`, 'the command card to be dismissed');
			check(!(await js(`Boolean([...${cardsOf}[1].querySelectorAll('.btn')].find((el) => el.textContent.trim() === 'Apply'))`)), 'a dismissed card still offered Apply');
			check(onDisk('base.yml') === beforeThree, 'dismissing a card changed the file');
			await js(`${inChat('Apply all 2')}.click()`);
			await waitFor(`${cardsOf}.filter((el) => el.dataset.status === 'applied').length === 2`, 'Apply all to apply both cards', 10000);
			check(onDisk('base.yml').includes('  - trigger: ";big"') && onDisk('base.yml').includes('Line 450 of 450') && onDisk('base.yml').includes('  - trigger: ";third"') && !onDisk('base.yml').includes(':ip'), 'Apply all did not write exactly the two cards that were waiting');

			// The assistant is told what became of its cards.
			await ask('ARGS');
			await answered(4);
			const told = await js(`${lastAnswer}.querySelector('.md').textContent`);
			check(told.includes('[Card shown to the person: Add a snippet to base.yml. Applied by the person.]') && told.includes('Dismissed by the person.'), 'the assistant was not told what happened to its cards');

			// What an answer contains is shown as text, whatever it says.
			await ask('SAY <img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script> [press](javascript:window.__pwned=1) **bold**');
			await answered(5);
			check(await js(`${lastAnswer}.querySelector('.md').textContent.includes('<img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script> press (javascript:window.__pwned=1) bold')`), 'the answer was not shown as written');
			check(await js(`window.__pwned === undefined && !${lastAnswer}.querySelector('img, script, a') && Boolean(${lastAnswer}.querySelector('strong'))`), 'an answer became markup');

			// Stop.
			await ask('SAY Thinking it over.\nSEARCH hello\nHANG');
			await waitFor(`document.querySelector('.chat__working') && ${lastAnswer}.querySelector('.msg__tools')?.textContent === 'Searched snippets'`, 'an answer under way');
			check(await js(`${inChat('New conversation')}.disabled`), 'a new conversation could be started mid-answer');
			await shot('19e-assistant-working');
			await js(`${inChat('Stop')}.click()`);
			await waitFor(`!document.querySelector('.chat__working') && ${lastAnswer}.querySelector('.msg__ending')?.textContent === 'Stopped.'`, 'the answer to stop');
			check(await js(`${lastAnswer}.querySelector('.md').textContent === 'Thinking it over.'`), 'what was said before the stop was lost');

			// A backend that fails says why.
			await ask('EXIT 3 You have hit your usage limit.');
			await answered(7);
			check((await js(`${lastAnswer}.querySelector('.alert')?.textContent.trim()`)) === 'Codex stopped unexpectedly: You have hit your usage limit.', 'the failure was not shown');

			// A find. The app's own closest matches are listed at once, while the
			// answer is still under way: they do not wait for the assistant.
			const zebras = (first) => `matches:\n${first}${Array.from({ length: 6 }, (_, index) => `  - trigger: ":zebra${index}"\n    replace: "Zebra number ${index}"\n`).join('')}`;
			const longZebra = `  - trigger: ":zebra-${'long-'.repeat(14)}trigger"\n    replace: "${'A zebra with a great deal to say. '.repeat(8)}"\n`;
			fs.writeFileSync(path.join(matchDir, 'zebras.yml'), zebras(longZebra));
			await waitFor(`[...document.querySelectorAll('.nav-item--file')].some((el) => el.textContent.includes('zebras.yml'))`, 'the new file to be seen');
			const rows = `[...${lastAnswer}.querySelectorAll('.found__row')]`;
			// The window is made to hear of the matches before it knows the answer's
			// name: they are kept, and shown once it does.
			const sendNow = backend.chat.send;
			backend.chat.send = async (input) => {
				const sent = await sendNow(input);
				await sleep(400);
				return sent;
			};
			await ask('Which zebra snippets do I have?\nSAY These.\nHANG');
			await waitFor(`document.querySelector('.chat__working') && ${rows}.length === 3`, 'the closest matches while the answer is under way');
			backend.chat.send = sendNow;
			check((await js(`${lastAnswer}.children[0].className`)) === 'found', 'the closest matches are not at the top of the answer');
			// They arrive a moment after the message, and the panel follows them down.
			const atBottom = `(() => { const log = document.querySelector('.chat__log'); return log.scrollHeight - log.scrollTop - log.clientHeight < 2; })()`;
			await sleep(200);
			check(await js(atBottom), 'the panel did not follow the closest matches down');
			check((await js(`${lastAnswer}.querySelector('.found__title').textContent`)) === 'Closest matches', 'the closest matches have no heading');
			check(
				JSON.stringify(await js(`${rows}.map((el) => [el.querySelector('.found__triggers').textContent.slice(0, 12), el.querySelector('.found__file').textContent, el.querySelector('.found__preview').textContent.slice(0, 14)])`)) ===
					JSON.stringify([[':zebra-long-', 'zebras.yml', 'A zebra with a'], [':zebra0', 'zebras.yml', 'Zebra number 0'], [':zebra1', 'zebras.yml', 'Zebra number 1']]),
				`the closest matches read: ${JSON.stringify(await js(`${rows}.map((el) => el.textContent)`))}`
			);
			check((await js(`${lastAnswer}.querySelector('.found__more').textContent`)) === 'Show all 7', `the rest are offered as: ${await js(`${lastAnswer}.querySelector('.found__more')?.textContent`)}`);
			const fits = `${rows}.every((el) => el.scrollWidth <= el.clientWidth && [...el.children].every((part) => part.getBoundingClientRect().right <= el.getBoundingClientRect().right + 0.5)) && document.querySelector('.chat__log').scrollWidth <= document.querySelector('.chat__log').clientWidth`;
			check(await js(fits), 'a long match spills out of its row');
			await shot('19l-assistant-found');
			await js(`${lastAnswer}.querySelector('.found__more').click()`);
			await waitFor(`${rows}.length === 7 && ${lastAnswer}.querySelector('.found__more').textContent === 'Show fewer' && ${lastAnswer}.querySelector('.found__more').getAttribute('aria-expanded') === 'true'`, 'every match to be listed');
			// At the panel's narrowest, nothing is cut off or spills.
			await js(`document.querySelector('.chat__resize').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))`);
			await waitFor(`Math.round(document.querySelector('.chat').getBoundingClientRect().width) === 320`, 'the panel at its narrowest');
			await sleep(200);
			check(await js(atBottom), 'made narrower, the panel lost its place at the end of the conversation');
			check(await js(fits), 'at 320 wide a match spills out of its row');
			await shot('19m-assistant-found-narrow');
			for (let press = 0; press < 5; press += 1) await js(`document.querySelector('.chat__resize').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`);
			await js(`${inChat('Stop')}.click()`);
			await waitFor(`!document.querySelector('.chat__working') && ${lastAnswer}.querySelector('.msg__ending')?.textContent === 'Stopped.'`, 'the find to stop');
			check(await js(`${rows}.length === 7`), 'stopping the answer took the matches away');

			// A row opens its snippet. The file has changed since, and the
			// snippet is opened where it is now, not where it was.
			fs.writeFileSync(path.join(matchDir, 'zebras.yml'), zebras('  - trigger: ":stripes"\n    replace: "New at the top"\n  - trigger: ":hooves"\n    replace: "And another"\n'));
			await waitFor(`[...document.querySelectorAll('.nav-item--file')].find((el) => el.textContent.includes('zebras.yml'))?.querySelector('.nav-count')?.textContent === '8'`, 'the changed file to be seen');
			await js(`${rows}.find((el) => el.querySelector('.found__triggers').textContent === ':zebra1').click()`);
			await waitFor(`document.querySelector('.crumbs__current')?.textContent === ':zebra1'`, 'the row to open its snippet where it is now');
			// With unsaved edits open, a row asks before it leaves them.
			await waitFor(`document.querySelector('.editor textarea')`, 'the editor for the opened row');
			await js(`window.__ui.type('.editor textarea', 'Edited before a row was pressed')`);
			await waitFor(`window.__ui.byText('Unsaved changes', '.badge')`, 'the unsaved badge before a row is pressed');
			await js(`${rows}.find((el) => el.querySelector('.found__triggers').textContent === ':zebra2').click()`);
			await waitFor(`document.querySelector('.dialog h2')?.textContent === 'Discard unsaved changes?'`, 'a row to ask before leaving unsaved edits');
			check((await js(`document.querySelector('.crumbs__current').textContent`)) === ':zebra1', 'a row left unsaved edits without asking');
			await js(`window.__ui.click('Keep editing')`);
			await waitFor(`!document.querySelector('.dialog')`, 'the question to close');
			check((await js(`document.querySelector('.editor textarea').value`)) === 'Edited before a row was pressed', 'keeping the edits lost them');
			// The long one is gone from the file: its row opens the file, once the edits are let go.
			await js(`${rows}[0].click()`);
			await waitFor(`document.querySelector('.dialog h2')?.textContent === 'Discard unsaved changes?'`, 'the question again');
			await js(`window.__ui.click('Discard changes')`);
			await waitFor(`document.querySelector('.crumbs__current')?.textContent === 'zebras.yml' && document.querySelector('.snippet-list')`, 'a row whose snippet is gone to open its file');
			check(!onDisk('zebras.yml').includes('Edited before a row was pressed'), 'discarded edits reached the file');
			check(!(await js(`document.querySelector('.chat').hidden`)), 'beside the page, the assistant closed when a row was opened');

			// History, and a new conversation.
			await js(`${inChat('New conversation')}.click()`);
			await waitFor(`document.querySelector('.chat__starter')`, 'a new, empty conversation');
			await js(`${inChat('Assistant options')}.click()`);
			await waitFor(`document.querySelector('.chat__menu')`, 'the options menu');
			await shot('19f-assistant-menu');
			await js(`[...document.querySelectorAll('.chat__menu button')].find((el) => el.textContent.trim() === 'History').click()`);
			await waitFor(`document.querySelectorAll('.chat__conversation').length === 1`, 'the conversation in History');
			await shot('19g-assistant-history');
			await js(`document.querySelector('.chat__conversation').click()`);
			await waitFor(`document.querySelectorAll('.msg--assistant').length === 8`, 'the conversation to come back');
			check(await js(`document.querySelectorAll('.found').length === 1 && document.querySelectorAll('.found__row').length === 3`), 'the closest matches were not kept with the conversation');

			// The one that was chosen stops being ready while another is. The
			// panel says so. It does not quietly send to the other.
			await js(`${inChat('Codex')}.click()`);
			await waitFor(`document.querySelector('.backends')`, 'who answers');
			await js(`[...document.querySelectorAll('.backend')].find((el) => el.textContent.includes('Codex')).querySelector('input').click()`);
			chatReady.codex = false;
			chatReady.ollama = true;
			await js(`${inChat('Check again')}.click()`);
			await waitFor(`document.querySelector('.chat__lead')?.textContent === 'Codex is not ready. Fix it and press Check again, or choose another.'`, 'the panel to say the chosen backend is not ready');
			check((await js(`document.querySelector('.chat__provider').textContent`)) === 'Not set up' && (await js(`document.querySelector('.chat__box').disabled`)), 'with the chosen backend gone, another was used without asking');
			// Chosen now, Ollama starts on the model that stays on this computer.
			await js(`[...document.querySelectorAll('.backend')].find((el) => el.textContent.includes('Ollama')).querySelector('input').click()`);
			await waitFor(`document.querySelector('.chat__provider').textContent === 'Ollama · on-this-computer:8b'`, 'Ollama to start on its local model');
			await shot('19k-assistant-choice');
			// The other way round: Ollama, now the choice, goes away and Codex is back. Nothing is sent to Codex until it is chosen.
			chatReady.codex = true;
			chatReady.ollama = false;
			await js(`${inChat('Check again')}.click()`);
			await waitFor(`document.querySelector('.chat__lead')?.textContent === 'Ollama is not ready. Fix it and press Check again, or choose another.'`, 'the panel to say Ollama is not ready');
			check((await js(`document.querySelector('.chat__provider').textContent`)) === 'Not set up', 'with Ollama gone, Codex was used without asking');
			await js(`[...document.querySelectorAll('.backend')].find((el) => el.textContent.includes('Codex')).querySelector('input').click()`);
			await waitFor(`document.querySelector('.chat__provider').textContent === 'Codex'`, 'Codex to be chosen and ready again');
			await js(`${inChat('Back to the conversation')}.click()`);

			// The options menu by keyboard: it takes the keys, and gives them back.
			await js(`${inChat('Assistant options')}.click()`);
			await waitFor(`document.activeElement?.getAttribute('role') === 'menuitem' && document.activeElement.textContent.trim() === 'History'`, 'the menu to take the keyboard');
			await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
			check((await js(`document.activeElement.textContent.trim()`)) === 'Who answers', 'the down arrow did not move through the menu');
			await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))`);
			check((await js(`document.activeElement.textContent.trim()`)) === 'Settings', 'End did not go to the last item');
			await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
			await waitFor(`!document.querySelector('.chat__menu') && document.activeElement?.getAttribute('aria-label') === 'Assistant options'`, 'Escape to close the menu and return to its button');

			// The window is reloaded while an answer is under way. The answer is
			// stopped, the conversation comes back, and the next message goes through.
			await ask('SAY Interrupted by a reload.\nHANG');
			await waitFor(`document.querySelector('.chat__working')`, 'an answer under way before the reload');
			await sleep(500);
			const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
			win.webContents.reload();
			await loaded;
			await js(HELPERS);
			await waitFor(`document.querySelector('.chat:not([hidden]) .msg--assistant')`, 'the panel and its conversation after a reload');
			check(await js(`[...document.querySelectorAll('.msg--assistant')].at(-1).querySelector('.msg__ending')?.textContent === 'Stopped.'`), 'the answer cut off by the reload does not say it was stopped');
			await ask('SAY After the reload.');
			await waitFor(`!document.querySelector('.chat__working') && [...document.querySelectorAll('.msg--assistant')].at(-1).textContent.includes('After the reload.')`, 'a message to be answered after the reload', 20000);
			check(!(await js(`Boolean(document.querySelector('.chat__notice .alert--danger'))`)), `after a reload the next message was refused: ${await js(`document.querySelector('.chat__notice')?.textContent`)}`);

			// In the dark, in a narrower window (where it covers the page), and closed again.
			await js(`document.querySelector('.sidebar__footer [aria-label="Dark"]').click()`);
			await shot('19h-assistant-dark');
			await js(`document.querySelector('.sidebar__footer [aria-label="Light"]').click()`);
			win.setContentSize(900, 700);
			await sleep(300);
			check(await js(`document.querySelector('.chat').getBoundingClientRect().width === window.innerWidth`), 'in a narrow window the assistant does not cover the page');
			await shot('19i-assistant-sheet');
			// From a card, "Show the file" goes to a page the sheet covers: the sheet makes way.
			await js(`[...document.querySelectorAll('.chat .btn')].find((el) => el.textContent.trim() === 'Show the file').click()`);
			await waitFor(`document.querySelector('.chat').hidden && document.querySelector('.snippet-list')`, 'the sheet to make way for the file');
			check(await js(`getComputedStyle(document.querySelector('.main')).visibility === 'visible'`), 'the page stayed hidden after the sheet closed');
			await js(`document.querySelector('.topbar [aria-pressed]').click()`);
			await waitFor(`!document.querySelector('.chat').hidden`, 'the assistant to open again');
			await js(`${inChat('Close the assistant')}.click()`);
			await waitFor(`document.querySelector('.chat').hidden`, 'the assistant to close');
			await waitFor(`document.activeElement?.getAttribute('aria-label') === 'Show the assistant'`, 'the keyboard to return to the button that opens the assistant');
			win.setContentSize(1440, 900);
			await sleep(200);

			// Quitting with an answer under way: its program is stopped and nothing of it stays on disk.
			await js(`document.querySelector('.topbar [aria-pressed]').click()`);
			await waitFor(`!document.querySelector('.chat').hidden`, 'the assistant to open once more');
			await ask('PID\nHANG');
			await waitFor(`document.querySelector('.chat__working') && /^\\d+$/.test([...document.querySelectorAll('.msg--assistant')].at(-1).querySelector('.md')?.textContent ?? '')`, 'the stand-in to say its process number');
			leftRunning = Number(await js(`[...document.querySelectorAll('.msg--assistant')].at(-1).querySelector('.md').textContent`));
			check(fs.readdirSync(path.join(app.getPath('userData'), 'chat')).some((name) => name.startsWith('chat-')), 'an answer under way has no listener file');
			await backend.service.saveSettings({ aiWrite: false });
		});
	}

	await waitFor(`document.querySelectorAll('.toast').length === 0`, 'every toast to dismiss itself', 9000);

	// The backend is shut down as the app shuts it down on quitting. An
	// answer was left under way on purpose: its program must be gone, and
	// nothing of it may stay on disk.
	await backend.dispose();
	if (leftRunning) {
		const alive = () => {
			try {
				process.kill(leftRunning, 0);
				return true;
			} catch {
				return false;
			}
		};
		for (let tries = 0; tries < 60 && alive(); tries += 1) await sleep(50);
		check(!alive(), 'shutting the backend down left the program of an answer running');
		const left = fs.readdirSync(path.join(app.getPath('userData'), 'chat')).filter((name) => name !== 'empty');
		check(left.length === 0, `shutting the backend down left files behind: ${left.join(', ')}`);
	} else if (process.platform !== 'win32') {
		failures.push('no answer was left under way for the shutdown check');
	}

	check(consoleProblems.length === 0, `console problems: ${consoleProblems.join(' | ')}`);
	fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify({ failures, consoleProblems }, null, 2));
	console.log(failures.length ? `UI smoke: ${failures.length} failure(s)\n- ${failures.join('\n- ')}` : 'UI smoke: all checks passed');
	fs.rmSync(sandbox, { recursive: true, force: true });
	clearTimeout(watchdog);
	app.exit(failures.length ? 1 : 0);
}

app.whenReady()
	.then(run)
	.catch((error) => {
		console.error(`UI smoke: crashed\n${error.stack ?? error}`);
		app.exit(1);
	});
