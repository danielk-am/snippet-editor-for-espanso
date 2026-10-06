import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = { matchDirOverride: null, maxBackups: 20, apiEnabled: false, apiPort: 27187, teamRepository: null, aiWrite: false };

function clean(raw) {
	const settings = { ...DEFAULTS };
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
	// Kept as text only. Whether it is an address the app accepts is decided
	// where it is used, each time, not here.
	if (typeof raw?.teamRepository === 'string' && raw.teamRepository && raw.teamRepository.length <= 300) {
		settings.teamRepository = raw.teamRepository;
	}
	return settings;
}

export async function loadSettings(file) {
	try {
		return clean(JSON.parse(await fs.readFile(file, 'utf8')));
	} catch {
		// Missing or damaged: the app still has to open.
		return { ...DEFAULTS };
	}
}

export async function saveSettings(file, patch) {
	const settings = clean({ ...(await loadSettings(file)), ...patch });
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(settings, null, '\t') + '\n');
	return settings;
}
