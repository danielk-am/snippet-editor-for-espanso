// Checks the packaged app, not the source tree: run `npm run pack` (or one of
// the dist scripts) first, then `npm run test:packaged`.
//
// It starts the app built for this computer against a throwaway copy of the
// fixtures, with its own data folder, and asks the running window what it is
// showing. The window appears on screen for a few seconds.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

// Where electron-builder leaves the unpacked app for each system.
const CANDIDATES = {
	darwin: [`mac-${process.arch}`, 'mac', 'mac-universal'].map((dir) => path.join(dist, dir, 'Snippet Editor.app', 'Contents', 'MacOS', 'Snippet Editor')),
	win32: [path.join(dist, 'win-unpacked', 'Snippet Editor.exe')],
	linux: [`linux-${process.arch}-unpacked`, 'linux-unpacked'].map((dir) => path.join(dist, dir, 'snippet-editor-for-espanso')),
};
const binary = (CANDIDATES[process.platform] ?? []).find((candidate) => fs.existsSync(candidate));
if (!binary) {
	console.error(`No packaged app for ${process.platform} ${process.arch} in dist/. Run "npm run pack" first.`);
	process.exit(1);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'snippet-editor-packaged-'));
const matchDir = path.join(sandbox, 'match');
const userData = path.join(sandbox, 'userData');
fs.cpSync(path.join(root, 'test', 'fixtures', 'match'), matchDir, { recursive: true });

const freePort = () =>
	new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (condition, message) => {
	if (!condition) failures.push(message);
};

const port = await freePort();
const child = spawn(binary, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
	env: { ...process.env, SNIPPET_EDITOR_MATCH_DIR: matchDir },
	stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk));
let exited = null;
child.on('exit', (code, signal) => (exited = { code, signal }));

async function findPage() {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		if (exited) throw new Error(`The app exited before it showed a window (${JSON.stringify(exited)}).\n${stderr}`);
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			const page = targets.find((target) => target.type === 'page' && target.url.startsWith('file:'));
			if (page) return page;
		} catch {
			// Not listening yet.
		}
		await sleep(200);
	}
	throw new Error('The app did not open a window within 20 seconds.');
}

// The smallest DevTools client that will do: one request, one answer.
function connect(url) {
	const socket = new WebSocket(url);
	const waiting = new Map();
	const problems = [];
	let nextId = 0;
	socket.addEventListener('message', (event) => {
		const message = JSON.parse(event.data);
		if (message.id && waiting.has(message.id)) {
			waiting.get(message.id)(message);
			waiting.delete(message.id);
		} else if (message.method === 'Runtime.exceptionThrown') {
			problems.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
		} else if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
			problems.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
		}
	});
	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const id = (nextId += 1);
			waiting.set(id, resolve);
			socket.send(JSON.stringify({ id, method, params }));
		});
	const evaluate = async (expression) => {
		const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
		return result.result.value;
	};
	return new Promise((resolve, reject) => {
		socket.addEventListener('open', () => resolve({ send, evaluate, problems, close: () => socket.close() }));
		socket.addEventListener('error', () => reject(new Error('Could not connect to the app window.')));
	});
}

try {
	const page = await findPage();
	const client = await connect(page.webSocketDebuggerUrl);
	await client.send('Runtime.enable');

	const deadline = Date.now() + 15000;
	while (Date.now() < deadline && !(await client.evaluate(`Boolean(document.querySelector('.stats'))`))) await sleep(200);

	const seen = await client.evaluate(`({
		url: location.href,
		platform: window.snippetEditor?.platform,
		stats: [...document.querySelectorAll('.stat__value')].map((el) => el.textContent),
		files: [...document.querySelectorAll('.nav-item--file .nav-item__label')].map((el) => el.textContent),
		folder: document.querySelector('.context-strip__path')?.textContent,
		loadError: document.querySelector('.boot')?.textContent ?? '',
	})`);

	check(seen.url.includes('app.asar'), `the window is not showing the packaged files: ${seen.url}`);
	check(seen.platform === process.platform, `the bridge to the main process is missing (platform was ${seen.platform})`);
	check(JSON.stringify(seen.stats) === JSON.stringify(['10', '4', '1', '1']), `overview showed ${JSON.stringify(seen.stats)} ${seen.loadError}`);
	check(JSON.stringify(seen.files) === JSON.stringify(['_shared.yml', 'base.yml', 'broken.yml', 'dates.yml', 'Goodbyes']), `sidebar listed ${JSON.stringify(seen.files)}`);
	check(seen.folder === matchDir, `the app read ${seen.folder}, not the test folder`);

	// One save, to prove the packaged app can write a file and keep a backup.
	await client.evaluate(`[...document.querySelectorAll('.nav-item__label')].find((el) => el.textContent === 'base.yml').click()`);
	await sleep(400);
	await client.evaluate(`document.querySelector('.snippet-row__open').click()`);
	await sleep(400);
	await client.evaluate(`(() => {
		const area = document.querySelector('.editor textarea');
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, 'Saved by the packaged app');
		area.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	await sleep(300);
	await client.evaluate(`[...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Save').click()`);
	const saveBy = Date.now() + 5000;
	const saved = () => fs.readFileSync(path.join(matchDir, 'base.yml'), 'utf8').includes('replace: "Saved by the packaged app"');
	while (Date.now() < saveBy && !saved()) await sleep(200);
	check(saved(), 'saving a snippet did not reach the file');
	check(fs.existsSync(path.join(userData, 'backups')), 'no backup was written to the app data folder');

	check(client.problems.length === 0, `console problems: ${client.problems.join(' | ')}`);
	client.close();
} catch (error) {
	failures.push(error.message);
}

child.kill();
await sleep(500);

// The MCP server that comes with the app, started the way Settings tells an
// AI tool to start it: by the app's own program, from the folder unpacked
// beside the app's archive. Nobody should need Node installed for this.
const resources = process.platform === 'darwin' ? path.join(path.dirname(binary), '..', 'Resources') : path.join(path.dirname(binary), 'resources');
const server = path.join(resources, 'app.asar.unpacked', 'mcp', 'server.mjs');
check(fs.existsSync(server), `the MCP server is not unpacked beside the app's archive: ${path.relative(root, server)}`);
if (fs.existsSync(server)) {
	const answer = await new Promise((resolve) => {
		const mcp = spawn(binary, [server], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SNIPPET_EDITOR_DATA_DIR: userData }, stdio: ['pipe', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		const giveUp = setTimeout(() => (mcp.kill(), resolve(`no answer. ${err}`)), 15000);
		mcp.stderr.on('data', (chunk) => (err += chunk));
		mcp.stdout.on('data', (chunk) => {
			out += chunk;
			if (out.split('\n').length < 3) return;
			clearTimeout(giveUp);
			mcp.stdin.end();
			resolve(out);
		});
		mcp.on('error', (error) => resolve(`could not start: ${error.message}`));
		const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
		mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } }) + '\n');
		mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } }) + '\n');
	});
	check(answer.includes('"supportedVersions":["2026-07-28"]'), `the packaged MCP server did not answer server/discover: ${answer.slice(0, 300)}`);
	check((answer.match(/"name":"snippets_/g) ?? []).length === 12, 'the packaged MCP server did not list its twelve tools');
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(failures.length ? `Packaged app: ${failures.length} failure(s)\n- ${failures.join('\n- ')}` : `Packaged app: all checks passed (${path.relative(root, binary)})`);
process.exit(failures.length ? 1 : 0);
