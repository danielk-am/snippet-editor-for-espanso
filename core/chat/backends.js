import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { MODEL_NAME } from './modelName.js';
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
//
// A ready backend also says which models it can answer with, so that the
// person can pick one. Ollama and Codex are asked for theirs. Claude Code has
// no way to be asked, and takes the short name of a family instead.

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

// Codex's list of models, as it prints it, is over half a megabyte.
const LONG = 4 * 1024 * 1024;

// A short question to a program: how it ended and what it printed.
const ask = (program, args, { most = 65_536, within = 5000 } = {}) =>
	new Promise((resolve, reject) => {
		execFile(program, args, { timeout: within, windowsHide: true, maxBuffer: most }, (error, stdout) => {
			if (error && typeof error.code !== 'number') return reject(error);
			resolve({ code: error ? error.code : 0, stdout: String(stdout ?? '') });
		});
	});

const numbers = (text) => {
	const found = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text).trim());
	return found ? found.slice(1).map(Number) : null;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const MOST_MODELS = 40;
const line = (value, most) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, most) : '');

// What Codex prints for `codex debug models --bundled`, as the models it
// lists, in the order it ranks them. Anything else it might print is no list.
//
// Two kinds of listed model are not offered. The app asks every model to
// think lightly, so one that cannot is left out. And how the assistant is
// kept to the snippet tools was settled with the model Codex chooses by
// itself: a model that uses tools another way than that one has not been
// tried, and is left out too.
function codexModels(stdout) {
	let said;
	try {
		said = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!isObject(said) || !Array.isArray(said.models)) return [];
	const rank = (model) => (typeof model.priority === 'number' && Number.isFinite(model.priority) ? model.priority : Infinity);
	const ranked = said.models
		.filter((model) => isObject(model) && model.visibility === 'list')
		.map((model, at) => ({ model, at }))
		.sort((a, b) => rank(a.model) - rank(b.model) || a.at - b.at)
		.map((item) => item.model);
	const way = ranked[0]?.tool_mode;
	const found = [];
	for (const model of ranked) {
		if (found.length === MOST_MODELS) break;
		if (typeof model.slug !== 'string' || !MODEL_NAME.test(model.slug) || model.tool_mode !== way) continue;
		const levels = model.supported_reasoning_levels;
		if (Array.isArray(levels) && !levels.some((level) => isObject(level) && level.effort === 'low')) continue;
		if (found.some((item) => item.name === model.slug)) continue;
		found.push({ name: model.slug, label: line(model.display_name, 60) || model.slug, about: line(model.description, 200) });
	}
	return found;
}

// Claude Code turns each of these into the latest model of its family.
const LATEST = 'Claude Code uses the latest model of this family.';
const CLAUDE_MODELS = [
	{ name: 'haiku', label: 'Haiku', about: 'The fastest family. Claude Code uses its latest model.' },
	{ name: 'sonnet', label: 'Sonnet', about: LATEST },
	{ name: 'opus', label: 'Opus', about: LATEST },
	{ name: 'fable', label: 'Fable', about: LATEST },
];

export function createBackends({ env = process.env, platform = process.platform, home = os.homedir(), isFile = exists, list = (dir) => fs.readdir(dir), quick = ask, ollama = createOllama(), patience = 5000 } = {}) {
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
		const version = await quick(program, ['--version'], { within: patience }).then((result) => numbers(result.stdout), () => null);
		if (version && compare(version, CLAUDE_NEEDS) < 0) {
			return entry('claude', 'old', `This Claude Code is version ${version.join('.')}, and the app needs ${CLAUDE_NEEDS.join('.')} or newer. Update Claude Code, then press Check again.`);
		}
		const signedIn = await quick(program, ['auth', 'status'], { within: patience }).then(
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
		return signedIn ? entry('claude', 'ready', '', { models: CLAUDE_MODELS.map((model) => ({ ...model })) }) : signedOut('claude', program, 'auth login');
	}

	async function codex() {
		const program = await locate('codex');
		if (!program) return entry('codex', 'missing', 'Codex is not installed on this computer.');
		const signedIn = await quick(program, ['login', 'status'], { within: patience }).then((result) => result.code === 0, () => false);
		if (!signedIn) return signedOut('codex', program, 'login');
		// Its own list, when it will give one. Without it, its own choice answers.
		// The list that came with the program is asked for: Codex has that
		// without asking anyone, where its fuller list is refreshed from OpenAI,
		// and looking at the backends sends nothing anywhere.
		const models = await quick(program, ['debug', 'models', '--bundled'], { most: LONG, within: patience }).then((result) => (result.code === 0 ? codexModels(result.stdout) : []), () => []);
		return entry('codex', 'ready', '', { models });
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
