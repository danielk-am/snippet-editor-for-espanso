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
import { startBackend } from '../electron/bootstrap.js';
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
		return {
			unnamed: controls.filter((el) => !named(el)).map(describe),
			small: controls
				.filter((el) => !el.matches('.sidebar__resize'))
				.filter((el) => { const r = el.getBoundingClientRect(); return Math.min(r.width, r.height) < 24; })
				.map(describe),
			overflow: document.documentElement.scrollWidth > window.innerWidth,
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
	const backend = await startBackend({
		ipcMain,
		userDataDir: app.getPath('userData'),
		env: { SNIPPET_EDITOR_MATCH_DIR: matchDir },
		onChange: () => win?.webContents.send('data:changed'),
		getWindow: () => win,
		isTrustedSender,
	});
	const services = backend.service;

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
	});

	await step('validation', async () => {
		await js(`window.__ui.type('.editor input', '')`);
		await js(`window.__ui.click('Save')`);
		await waitFor(`document.querySelector('.field__error')?.textContent === 'Add a trigger.'`, 'the missing-trigger message');
		check(onDisk('base.yml').includes('";smoke"'), 'an invalid snippet was saved');
		await js(`window.__ui.type('.editor input', ';smoke')`);
		await waitFor(`!document.querySelector('.field__error')`, 'the message to clear once the trigger is back');
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

		const token = fs.readFileSync(path.join(app.getPath('userData'), 'api-token'), 'utf8').trim();
		check(!(await js(`document.body.innerHTML.includes(${JSON.stringify(token)})`)), 'the token is present in the page');
		check((await reach()) === 401, 'the API answered without a token');
		check((await reach({ Authorization: `Bearer ${token}`, Origin: 'https://example.com' })) === 403, 'the API answered a web page');
		const reply = await fetch(`${address}/state`, { headers: { Authorization: `Bearer ${token}` } });
		const state = await reply.json();
		check(reply.status === 200 && state.files.length === 4, `the API returned ${reply.status} with ${state.files?.length} files`);

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
