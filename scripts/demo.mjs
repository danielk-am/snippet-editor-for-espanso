// Opens the app on a throwaway copy of the test fixtures, so you can try
// every feature without touching your real Espanso files.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const matchDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snippet-editor-demo-')), 'match');
fs.cpSync(path.join(root, 'test', 'fixtures', 'match'), matchDir, { recursive: true });

console.log(`Demo match folder: ${matchDir}`);
spawn(electron, [root], { stdio: 'inherit', env: { ...process.env, SNIPPET_EDITOR_MATCH_DIR: matchDir } }).on('exit', (code) =>
	process.exit(code ?? 0)
);
