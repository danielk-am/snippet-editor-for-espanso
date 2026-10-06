import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = { matchDirOverride: null, maxBackups: 20 };

function clean(raw) {
	const settings = { ...DEFAULTS };
	if (typeof raw?.matchDirOverride === 'string' && raw.matchDirOverride) {
		settings.matchDirOverride = raw.matchDirOverride;
	}
	if (Number.isInteger(raw?.maxBackups) && raw.maxBackups >= 1 && raw.maxBackups <= 500) {
		settings.maxBackups = raw.maxBackups;
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
