import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicFile } from './atomicFile.js';
import { MAX_TEAM_REPOSITORIES } from '../shared/teamLimits.js';

// How many team repositories can be connected at once. The number is kept
// where the window can read it too.
export { MAX_TEAM_REPOSITORIES };

// A function, so that no two callers are handed the same list.
const defaults = () => ({ matchDirOverride: null, maxBackups: 20, apiEnabled: false, apiPort: 27187, teamRepositories: [], aiWrite: false });

const isAddressText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 300;

function clean(raw) {
	const settings = defaults();
	if (typeof raw?.matchDirOverride === 'string' && raw.matchDirOverride) {
		settings.matchDirOverride = raw.matchDirOverride;
	}
	if (Number.isInteger(raw?.maxBackups) && raw.maxBackups >= 1 && raw.maxBackups <= 500) {
		settings.maxBackups = raw.maxBackups;
	}
	// The listener is on only when it was switched on, never by accident.
	if (raw?.apiEnabled === true) settings.apiEnabled = true;
	if (Number.isInteger(raw?.apiPort) && raw.apiPort >= 1024 && raw.apiPort <= 65535) {
		settings.apiPort = raw.apiPort;
	}
	// AI tools may change snippets only when this was switched on.
	if (raw?.aiWrite === true) settings.aiWrite = true;
	// Kept as text only. Whether each is an address the app accepts, and
	// whether two of them are one repository, is decided where they are used,
	// each time, not here.
	if (Array.isArray(raw?.teamRepositories)) {
		settings.teamRepositories = [...new Set(raw.teamRepositories.filter(isAddressText))].slice(0, MAX_TEAM_REPOSITORIES);
	} else if (isAddressText(raw?.teamRepository)) {
		// Before there could be several, the one address was saved under this
		// name. It is read as a list of one, and written as a list from then on.
		settings.teamRepositories = [raw.teamRepository];
	}
	return settings;
}

async function read(file) {
	const raw = JSON.parse(await fs.readFile(file, 'utf8'));
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid settings');
	return clean(raw);
}

export async function loadSettings(file, { onRecovery = () => {} } = {}) {
	try {
		return await read(file);
	} catch (error) {
		try {
			const recovered = await read(`${file}.last-good`);
			// A recovered older preference must not restore an old permission.
			recovered.apiEnabled = false;
			recovered.aiWrite = false;
			onRecovery('Settings could not be read. The last good settings were recovered. API access and AI writes are off; review them in Settings.');
			return recovered;
		} catch {
			if (error.code !== 'ENOENT') onRecovery('Settings could not be read and no good copy was available. Default settings are in use.');
			return defaults();
		}
	}
}

const pending = new Map();
export function saveSettings(file, patch) {
	const key = path.resolve(file);
	const run = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
		// Atomic replacement must still honour an explicitly read-only settings file.
		await fs.access(file, fs.constants.W_OK).catch((error) => { if (error.code !== 'ENOENT') throw error; });
		const previous = await loadSettings(file);
		const settings = clean({ ...previous, ...patch });
		await atomicFile(`${file}.last-good`, JSON.stringify(previous, null, '\t') + '\n');
		await atomicFile(file, JSON.stringify(settings, null, '\t') + '\n');
		return settings;
	});
	pending.set(key, run);
	const clear = () => { if (pending.get(key) === run) pending.delete(key); };
	run.then(clear, clear);
	return run;
}
