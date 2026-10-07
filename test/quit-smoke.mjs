// The real app, started from source in a folder of its own, is asked to quit
// the way the system asks, and must be gone soon after.
//
// This is the one thing the unit tests cannot show. Electron takes no notice
// of a quit asked for while it is still telling 'will-quit', and only the real
// one behaves that way. An app that does not go keeps running with no window
// and everything behind it stopped; opened again from the Dock, every message
// to the assistant is refused with "The app is closing."
//
//   npm run test:quit
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

if (process.platform === 'win32') {
	console.log('Quit smoke: skipped on Windows, where a signal ends a program without asking it.');
	process.exit(0);
}

const appDir = fileURLToPath(new URL('..', import.meta.url));
const sandbox = mkdtempSync(join(os.tmpdir(), 'snippet-editor-quit-'));
const userData = join(sandbox, 'userData');
const matchDir = join(sandbox, 'match');
mkdirSync(matchDir);
writeFileSync(join(matchDir, 'base.yml'), 'matches:\n  - trigger: ":hi"\n    replace: "Hello"\n');

const child = spawn(electron, [appDir, `--user-data-dir=${userData}`], { env: { ...process.env, SNIPPET_EDITOR_MATCH_DIR: matchDir }, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));
let exited = null;
child.on('exit', (code, signal) => (exited = { code, signal }));

const fail = (message) => {
	console.error(`Quit smoke: ${message}`);
	if (!exited) child.kill('SIGKILL');
	rmSync(sandbox, { recursive: true, force: true });
	process.exit(1);
};

// Up: its window has stored something. Then a moment more, to be at rest.
const until = Date.now() + 30_000;
while (!existsSync(join(userData, 'Local Storage'))) {
	if (exited) fail(`the app ended before it showed a window (${JSON.stringify(exited)}).\n${stderr}`);
	if (Date.now() > until) fail('the app did not show a window in 30 seconds.');
	await wait(100);
}
await wait(1500);
if (exited) fail(`the app ended by itself (${JSON.stringify(exited)}).\n${stderr}`);

const asked = Date.now();
child.kill('SIGTERM');
while (!exited && Date.now() - asked < 8000) await wait(20);
const took = Date.now() - asked;
if (!exited) fail('asked to quit, the app was still running 8 seconds later.');
if (exited.code !== 0) fail(`the app quit with ${JSON.stringify(exited)}.\n${stderr}`);
rmSync(sandbox, { recursive: true, force: true });
console.log(`Quit smoke: asked to quit, the app was gone ${took} ms later.`);
