import fs from 'node:fs/promises';
import path from 'node:path';

// How many team repositories can be connected at once.
export const MAX_TEAM_REPOSITORIES = 10;

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

export async function loadSettings(file) {
	try {
		return clean(JSON.parse(await fs.readFile(file, 'utf8')));
	} catch {
		// Missing or damaged: the app still has to open.
		return defaults();
	}
}

export async function saveSettings(file, patch) {
	const settings = clean({ ...(await loadSettings(file)), ...patch });
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(settings, null, '\t') + '\n');
	return settings;
}
