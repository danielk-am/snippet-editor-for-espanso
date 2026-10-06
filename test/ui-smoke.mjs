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
import { MANIFEST, MATCHES, gitEnv, seeded } from './helpers/teamRemote.js';
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
	console.error('UI smoke: timed out after 120 seconds');
	app.exit(1);
}, 120000);

async function run() {
	let win = null;
	// What the app copies lands here, not on the real clipboard.
	const copied = [];
	// A team repository in the sandbox, reached with the real git. Links the
	// app would open in a browser land in `opened` instead.
	const remote = seeded(path.join(sandbox, 'team-remote'));
	remote.commit({
		'packages/tools/_manifest.yml': MANIFEST('tools'),
		'packages/tools/package.yml': 'matches:\n  - trigger: ":ip"\n    replace: "{{ip}}"\n    vars:\n      - name: ip\n        type: shell\n        params:\n          cmd: "ipconfig getifaddr en0"\n',
	});
	const opened = [];
	const backend = await startBackend({
		ipcMain,
		userDataDir: app.getPath('userData'),
		env: { SNIPPET_EDITOR_MATCH_DIR: matchDir },
		onChange: () => win?.webContents.send('data:changed'),
		getWindow: () => win,
		isTrustedSender,
		clipboard: { writeText: (text) => copied.push(text) },
		openExternal: async (url) => opened.push(url),
		git: createGit({ allowLocal: true, env: gitEnv(remote.root) }),
		allowLocalRepositories: true,
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
		const card = (title) => `[...document.querySelectorAll('.team-card')].find((el) => el.querySelector('h2').textContent === ${JSON.stringify(title)})`;
		const inCard = (title, label) => `[...${card(title)}.querySelectorAll('button')].find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;
		const badge = (title, label) => `[...(${card(title)}?.querySelectorAll('.badge') ?? [])].some((el) => el.textContent.trim() === ${JSON.stringify(label)})`;
		const teamFile = (...parts) => path.join(matchDir, 'team', ...parts);
		// The page's buttons are off while one thing runs, as a person would
		// find them. Wait for the button to be ready, then press it.
		const press = async (button, label) => {
			await waitFor(`(${button}) && !(${button}).disabled`, `${label} to be ready`);
			await js(`(${button}).click()`);
		};

		// Connect, from Settings.
		await js(`window.__ui.type('.setting__team input', 'ext::sh -c "touch /tmp/owned"')`);
		await js(`window.__ui.click('Connect')`);
		await waitFor(`document.querySelector('.setting__team + .field__error, .field__error')?.textContent.startsWith('That is not a repository address.')`, 'a bad address to be refused in the field');
		await js(`window.__ui.type('.setting__team input', ${JSON.stringify(remote.url)})`);
		await js(`window.__ui.click('Connect')`);
		await waitFor(`[...document.querySelectorAll('.copy-row code')].some((el) => el.textContent === ${JSON.stringify(remote.url)})`, 'Settings to show the connected repository');
		await shot('09e-settings-team');
		// The test repository is a folder, which has no web pages. Give it the
		// web address a GitHub repository would have, so the link to the pull
		// request page can be followed through to the browser stand-in.
		backend.service.team().address.webUrl = 'https://github.com/acme/team-snippets';

		// Browse and install.
		await js(`window.__ui.click('Team packages', '.nav-item__label')`);
		await waitFor(`document.querySelectorAll('.team-card').length === 3`, 'three team packages');
		await shot('17-team');
		await press(inCard('Support replies', 'Install'), 'Install on the support package');
		await waitFor(badge('Support replies', 'Installed'), 'the support package to be installed');
		check(fs.readFileSync(teamFile('support', 'replies.yml'), 'utf8') === MATCHES([':refund', 'Your refund is on its way.']), 'the installed file is not the file in the repository');
		await waitFor(`window.__ui.byText('Support replies', '.nav-item__label')`, 'the package in the sidebar');
		await js(`window.__ui.click('escalations.yml', '.nav-item__label')`);
		await waitFor(`document.querySelectorAll('.snippet-row').length === 3`, 'the three snippets of a team file');
		check(!(await js(`Boolean(window.__ui.byText('New snippet', '.page-head__actions button'))`)), 'a team file offered New snippet');
		await js(`document.querySelector('.snippet-row__open').click()`);
		await waitFor(`document.querySelector('.alert__title')?.textContent === 'This snippet belongs to a team package'`, 'the read-only notice for a team snippet');
		check(await js(`document.querySelector('.editor textarea').disabled`), 'a team snippet was editable');
		await shot('17b-team-snippet');

		// A package that runs commands asks first.
		await js(`window.__ui.click('Team packages', '.nav-item__label')`);
		await waitFor(badge('Tools', 'Runs commands'), 'the warning on a package that runs commands');
		await press(inCard('Tools', 'Install'), 'Install on the tools package');
		await waitFor(`document.querySelector('.dialog h2')?.textContent === 'This package runs commands'`, 'the question before installing it');
		await shot('17c-team-runs-commands');
		check(!fs.existsSync(teamFile('tools')), 'the package was installed before the answer');
		await js(`[...document.querySelectorAll('.dialog__foot button')].at(-1).click()`);
		await waitFor(badge('Tools', 'Installed'), 'the package to be installed once accepted');

		// A change in the repository shows as an update, for that package only.
		remote.commit({ 'packages/support/replies.yml': MATCHES([':refund', 'Refund sent today.']) });
		await press(`window.__ui.byText('Check for updates')`, 'Check for updates');
		await waitFor(badge('Support replies', 'Update available'), 'the update notice');
		check(!(await js(badge('Tools', 'Update available'))), 'an unchanged package was marked for update');
		await shot('17d-team-update');
		await press(inCard('Support replies', 'Update'), 'Update on the support package');
		await waitFor(`!(${badge('Support replies', 'Update available')})`, 'the update to finish');
		check(fs.readFileSync(teamFile('support', 'replies.yml'), 'utf8') === MATCHES([':refund', 'Refund sent today.']), 'the update did not reach the installed file');

		// Remove, with a question first.
		await press(inCard('Tools', 'Remove'), 'Remove on the tools package');
		await waitFor(`document.querySelector('.dialog h2')?.textContent === 'Remove Tools?'`, 'the question before removing');
		await js(`[...document.querySelectorAll('.dialog__foot button')].at(-1).click()`);
		await waitFor(`${inCard('Tools', 'Install')}`, 'the package to be removed');
		check(!fs.existsSync(teamFile('tools')), 'the removed package is still on disk');

		// Propose one of your own files.
		await js(`window.__ui.click('dates.yml', '.nav-item__label')`);
		await waitFor(`window.__ui.byText('Propose to team')`, 'the Propose button on a local file');
		await js(`window.__ui.click('Propose to team')`);
		await waitFor(`document.querySelector('.dialog select')`, 'the proposal dialog');
		await js(`window.__ui.type('.dialog input[name=summary]', 'Share the date snippets')`);
		await shot('18-propose');
		await js(`{ const send = window.__ui.byText('Send proposal'); send.click(); send.click(); } true;`);
		await waitFor(`document.querySelector('.dialog h2')?.textContent === 'Proposal sent'`, 'the proposal to be sent', 15000);
		const proposals = remote.branches().filter((name) => name.startsWith('snippet-editor/'));
		check(proposals.length === 1, `a double click on Send made ${proposals.length} branches`);
		check(remote.show(proposals[0], 'packages/goodbyes/dates.yml') + '\n' === onDisk('dates.yml'), 'the proposed file is not the file on disk');
		check(await js(`document.querySelector('.dialog code')?.textContent === ${JSON.stringify(proposals[0])}`), 'the dialog does not name the branch');
		await shot('18b-proposal-sent');
		await js(`window.__ui.click('Open pull request page')`);
		await waitFor(`true`, 'a moment');
		await sleep(200);
		check(opened.length === 1 && opened[0] === `https://github.com/acme/team-snippets/compare/main...${proposals[0]}?expand=1`, `the pull request page opened was ${JSON.stringify(opened)}`);
		await js(`window.__ui.click('Close')`);

		// Only a link inside the connected repository can be opened.
		for (const link of ['https://evil.example/acme/team-snippets/compare/main...x', 'https://github.com/evil/other/compare/main...x', 'file:///etc/hosts']) {
			const refused = await js(`window.snippetEditor.invoke('team:openLink', ${JSON.stringify(link)}).then(JSON.stringify)`);
			check(JSON.parse(refused).ok === false && opened.length === 1, `a link elsewhere was opened: ${link} ${refused}`);
		}
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

	await waitFor(`document.querySelectorAll('.toast').length === 0`, 'every toast to dismiss itself', 9000);

	check(consoleProblems.length === 0, `console problems: ${consoleProblems.join(' | ')}`);
	fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify({ failures, consoleProblems }, null, 2));
	console.log(failures.length ? `UI smoke: ${failures.length} failure(s)\n- ${failures.join('\n- ')}` : 'UI smoke: all checks passed');
	await backend.dispose();
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
