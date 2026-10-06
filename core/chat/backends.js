import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { createOllama } from './ollama.js';

// Which of the three backends are on this computer, and whether each is
// ready to answer. When one is not, it says the one step that fixes it.
//
// Signing in stays the person's: the app runs each tool's own "am I signed
// in" check and shows the command to run. It never handles a sign-in itself.
//
// A program is looked for on the PATH, then where it is usually installed
// (an app started from the Dock gets a short PATH), then inside the desktop
// apps that carry a copy: Claude's and ChatGPT's.

// Older than this, Claude Code does not know `--permission-prompts`.
const CLAUDE_NEEDS = [2, 1, 259];

const SENDS_TO = { claude: 'Anthropic', codex: 'OpenAI', ollama: null };
const LABEL = { claude: 'Claude Code', codex: 'Codex', ollama: 'Ollama' };

const exists = async (file) => {
	try {
		if (!(await fs.stat(file)).isFile()) return false;
		if (process.platform !== 'win32') await fs.access(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

// A short question to a program: how it ended and what it printed.
const ask = (program, args) =>
	new Promise((resolve, reject) => {
		execFile(program, args, { timeout: 5000, windowsHide: true, maxBuffer: 65_536 }, (error, stdout) => {
			if (error && typeof error.code !== 'number') return reject(error);
			resolve({ code: error ? error.code : 0, stdout: String(stdout ?? '') });
		});
	});

const numbers = (text) => {
	const found = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text).trim());
	return found ? found.slice(1).map(Number) : null;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export function createBackends({ env = process.env, platform = process.platform, home = os.homedir(), isFile = exists, list = (dir) => fs.readdir(dir), quick = ask, ollama = createOllama() } = {}) {
	const path = platform === 'win32' ? nodePath.win32 : nodePath.posix;
	const fileName = (name) => (platform === 'win32' ? `${name}.exe` : name);

	const onPath = () => {
		const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
		return String(key ? env[key] : '')
			.split(path.delimiter)
			.filter(Boolean);
	};
	const usual = () =>
		platform === 'win32'
			? [path.join(home, '.local', 'bin')]
			: [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.volta', 'bin')];

	// The copy of Claude Code inside the Claude desktop app: newest first.
	async function bundledClaude() {
		const root = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
		const versions = (await list(root).catch(() => []))
			.map((name) => ({ name, parts: numbers(name) }))
			.filter((version) => version.parts)
			.sort((a, b) => compare(b.parts, a.parts));
		const found = [];
		for (const version of versions) {
			const builds = (await list(path.join(root, version.name)).catch(() => [])).sort().reverse();
			for (const build of builds) found.push(path.join(root, version.name, build, 'claude.app', 'Contents', 'MacOS', 'claude'));
		}
		return found;
	}

	const bundledCodex = () => ['/Applications', path.join(home, 'Applications')].flatMap((apps) => [path.join(apps, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'), path.join(apps, 'Codex.app', 'Contents', 'Resources', 'codex')]);

	async function locate(id) {
		if (id !== 'claude' && id !== 'codex') return null;
		const candidates = [...onPath(), ...usual()].map((dir) => path.join(dir, fileName(id)));
		if (platform === 'darwin') candidates.push(...(id === 'claude' ? await bundledClaude() : bundledCodex()));
		for (const candidate of candidates) {
			if (await isFile(candidate)) return candidate;
		}
		return null;
	}

	// The program's path as a terminal takes it.
	const quoted = (program) => {
		if (platform === 'win32') return `"${program}"`;
		return /^[A-Za-z0-9_@%+=:,./-]+$/.test(program) ? program : `'${program.replaceAll("'", "'\\''")}'`;
	};

	const entry = (id, state, message = '', extra = {}) => ({ id, label: LABEL[id], ready: state === 'ready', state, message, command: null, sendsTo: SENDS_TO[id], models: [], ...extra });
	const signedOut = (id, program, words) => entry(id, 'signed-out', `${LABEL[id]} is not signed in. Run this in a terminal, then press Check again.`, { command: `${quoted(program)} ${words}` });

	async function claude() {
		const program = await locate('claude');
		if (!program) return entry('claude', 'missing', 'Claude Code is not installed on this computer.');
		const version = await quick(program, ['--version']).then((result) => numbers(result.stdout), () => null);
		if (version && compare(version, CLAUDE_NEEDS) < 0) {
			return entry('claude', 'old', `This Claude Code is version ${version.join('.')}, and the app needs ${CLAUDE_NEEDS.join('.')} or newer. Update Claude Code, then press Check again.`);
		}
		const signedIn = await quick(program, ['auth', 'status']).then(
			(result) => {
				try {
					const said = JSON.parse(result.stdout);
					if (typeof said?.loggedIn === 'boolean') return said.loggedIn;
				} catch {
					// Not JSON: the way it ended decides.
				}
				return result.code === 0;
			},
			() => false
		);
		return signedIn ? entry('claude', 'ready') : signedOut('claude', program, 'auth login');
	}

	async function codex() {
		const program = await locate('codex');
		if (!program) return entry('codex', 'missing', 'Codex is not installed on this computer.');
		const signedIn = await quick(program, ['login', 'status']).then((result) => result.code === 0, () => false);
		return signedIn ? entry('codex', 'ready') : signedOut('codex', program, 'login');
	}

	async function local() {
		try {
			await ollama.version();
			const names = await ollama.models();
			if (!names.length) return entry('ollama', 'no-models', 'Ollama has no models yet. Add one that can use tools, then press Check again.');
			// A cloud model runs on Ollama's computers, under the person's Ollama sign-in.
			return entry('ollama', 'ready', '', { models: names.map((name) => ({ name, cloud: /[-:]cloud$/.test(name) })) });
		} catch {
			return entry('ollama', 'not-running', 'Ollama is not answering on this computer. Open Ollama, then press Check again.');
		}
	}

	return {
		locate,
		status: () => Promise.all([claude(), codex(), local()]),
	};
}
