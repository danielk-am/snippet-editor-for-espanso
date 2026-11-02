import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { app, ipcMain } from 'electron';
import { localGit } from './helpers/teamRemote.js';
import { startBackend } from '../electron/bootstrap.js';
import { createMainWindow, isTrustedSender } from '../electron/window.js';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'snippet-hardening-'));
const matchDir = path.join(sandbox, 'match');
fs.mkdirSync(matchDir);
fs.writeFileSync(path.join(matchDir, 'base.yml'), 'matches:\n  - trigger: ":hi"\n    replace: Hello\n    vars:\n      - name: first\n        type: custom\n        params: {x: 1}\n      - name: second\n        type: custom\n        params: {x: 2}\n');
app.setPath('userData', path.join(sandbox, 'profile'));
app.on('window-all-closed', () => {});
const timer = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
let win;
const backend = await startBackend({ git: localGit(sandbox), ipcMain, userDataDir: app.getPath('userData'), env: { SNIPPET_EDITOR_MATCH_DIR: matchDir }, getWindow: () => win, isTrustedSender });
let choice = 2;
let prompts = 0;
win = createMainWindow({ confirmClose: async () => { prompts++; return choice; } });
const js = (code) => win.webContents.executeJavaScript(code);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(code) { for (let i = 0; i < 200; i++) { if (await js(code)) return; await sleep(25); } throw new Error('Timed out: ' + code); }
const type = (selector, value) => js(`{const el=document.querySelector(${JSON.stringify(selector)}); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true}));}`);
try {
	await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
	await wait(`document.querySelector('.app')`);
	win.webContents.send('menu:command', 'new-snippet');
	await wait(`document.querySelector('.editor input')`);
	await type('.editor input', ':recovered');
	await type('.editor textarea', 'Unsaved content');
	await wait(`localStorage.getItem('snippet-editor:draft:v1:' + ${JSON.stringify(matchDir)})`);
	win.webContents.reload();
	await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
	await wait(`document.querySelector('.editor input')?.value === ':recovered'`);
	assert.equal(await js(`document.querySelector('.editor textarea').value`), 'Unsaved content');
	await type('.editor__aside textarea', '[');
	await wait(`document.querySelector('.action-bar__status')?.textContent.includes('Fix')`);
	win.close();
	await sleep(300);
	assert.equal(prompts, 1);
	assert.equal(win.isDestroyed(), false);
	// Invalid YAML stays recoverable and Save cannot close the window.
	choice = 0;
	win.close();
	await sleep(300);
	assert.equal(win.isDestroyed(), false);
	win.webContents.reload();
	await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
	await wait(`document.querySelector('.editor__aside textarea')?.value === '['`);
	await type('.editor__aside textarea', '');
	await wait(`!document.querySelector('.action-bar__status')?.textContent.includes('Fix')`);
	win.close();

	await sleep(300);
	assert.equal(win.isDestroyed(), true);
	assert.match(fs.readFileSync(path.join(matchDir, 'base.yml'), 'utf8'), /Unsaved content/);
	// Reopen the same profile: a successful Save has removed its draft.
	win = createMainWindow({ confirmClose: async () => choice });
	await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
	await wait(`document.querySelector('.app')`);
	assert.equal(await js(`document.querySelector('.editor') !== null`), false);
	await js(`[...document.querySelectorAll('.nav-item__label')].find(el=>el.textContent==='base.yml').click()`);
	await wait(`document.querySelector('[role="tab"]')`);
	await js(`[...document.querySelectorAll('[role="tab"]')].find(el=>el.textContent==='Raw YAML').click()`);
	await wait(`document.querySelector('.raw-editor:not(:disabled)')`);
	const before = fs.readFileSync(path.join(matchDir, 'base.yml'), 'utf8');
	await type('.raw-editor', before + '\n# local unsaved');
	await wait(`window.snippetEditorHasUnsavedChanges()`);
	const external = before + '\n# edited externally';
	fs.writeFileSync(path.join(matchDir, 'base.yml'), external);
	win.webContents.reload();
	await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
	await wait(`document.querySelector('.raw-editor')?.value.includes('# local unsaved')`);
	choice = 0;
	win.close();
	await sleep(300);
	assert.equal(win.isDestroyed(), false, 'a stale recovered raw draft must not close as saved');
	assert.equal(fs.readFileSync(path.join(matchDir, 'base.yml'), 'utf8'), external);
	choice = 1;
	win.close();
	await sleep(300);
	assert.equal(win.isDestroyed(), true);
	win = createMainWindow({ confirmClose: async () => choice });
	await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
	await wait(`document.querySelector('.app')`);
	assert.equal(await js(`localStorage.getItem('snippet-editor:draft:v1:' + ${JSON.stringify(matchDir)})`), null);
	// Removing a variable must preserve the next variable's unparsed text,
	// and must not leave an invisible validation error after the last removal.
	await js(`[...document.querySelectorAll('.nav-item__label')].find(el=>el.textContent==='base.yml').click()`);
	await wait(`document.querySelector('.snippet-row')`);
	await js(`[...document.querySelectorAll('.snippet-row')].find(el=>el.querySelector('.snippet-row__triggers')?.textContent.trim()===':hi').querySelector('.snippet-row__open').click()`);
	await wait(`document.querySelectorAll('.var-row textarea').length === 2`);
	await type('.var-row:nth-child(2) textarea', '[');
	await js(`document.querySelector('[aria-label="Remove variable first"]').click()`);
	await wait(`document.querySelectorAll('.var-row').length === 1`);
	win.webContents.reload();
	await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
	await wait(`document.querySelector('.var-row textarea')?.value === '['`);
	assert.equal(await js(`window.snippetEditorCloseAction('save')`), false);
	await js(`document.querySelector('[aria-label="Remove variable second"]').click()`);
	await wait(`document.querySelectorAll('.var-row').length === 0`);
	win.webContents.reload();
	await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
	await wait(`document.querySelector('.editor')`);
	assert.equal(await js(`window.snippetEditorCloseAction('save')`), true);
	// Refreshing after creation changes the file version before navigation.
	// That intermediate render must not treat a new draft as a moved snippet.
	await wait(`!window.snippetEditorHasUnsavedChanges()`);
	win.webContents.send('menu:command', 'new-snippet');
	await wait(`document.querySelector('.page h1')?.textContent === 'New snippet'`);
	await type('.editor input', ':created');
	await type('.editor textarea', 'Created without a stale editor');
	await js(`[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='Add snippet').click()`);
	await wait(`[...document.querySelectorAll('button')].some(el=>el.textContent.trim()==='Duplicate')`);
	assert.equal(await js(`document.querySelectorAll('.editor').length`), 1);
	await js(`[...document.querySelectorAll('.nav-item__label')].find(el=>el.textContent==='Settings').click()`);
	await wait(`document.querySelector('.page h1')?.textContent === 'Settings'`);
	assert.equal(await js(`document.querySelectorAll('.editor').length`), 0, 'navigation removes the saved new editor');
	console.log('Hardening smoke passed: recovery, invalid YAML, disk conflict, variable removal, Cancel, Save and Discard on close.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { win?.destroy(); await backend.dispose(); clearTimeout(timer); app.exit(process.exitCode ?? 0); }

}).catch((error) => { console.error(error); app.exit(1); });
