import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../core/store.js';
import { resolveMatchDir } from '../core/espansoPaths.js';
import { loadSettings, saveSettings } from '../core/settings.js';

// Owns the pieces that depend on where the match folder is: the store, and a
// watcher that tells the window when Espanso files change underneath it.
export async function createServices({ userDataDir, env = process.env, onChange = () => {} }) {
	const settingsFile = path.join(userDataDir, 'settings.json');
	let backupDir;
	let location;
	let settings;
	let store;
	let watcher = null;
	let timer;

	function watch() {
		watcher?.close();
		watcher = null;
		try {
			watcher = fs.watch(location.matchDir, { recursive: true }, () => {
				clearTimeout(timer);
				timer = setTimeout(onChange, 200);
			});
			watcher.on('error', () => {
				watcher?.close();
				watcher = null;
			});
		} catch {
			// The folder does not exist yet; state() tries again on each load.
		}
	}

	async function configure() {
		settings = await loadSettings(settingsFile);
		location = resolveMatchDir({
			override: settings.matchDirOverride,
			env,
			platform: process.platform,
			homedir: os.homedir(),
			exists: fs.existsSync,
		});
		// Each match folder gets its own backups, so two folders that both
		// hold a base.yml never push each other's copies out.
		const folder = createHash('sha256').update(location.matchDir).digest('hex').slice(0, 12);
		backupDir = path.join(userDataDir, 'backups', folder);
		store = createStore({ matchDir: location.matchDir, backupDir, maxBackups: settings.maxBackups });
		watch();
	}

	await configure();

	return {
		get store() {
			return store;
		},
		get backupDir() {
			return backupDir;
		},
		async state() {
			if (!watcher) watch();
			return { ...(await store.inventory()), matchDirSource: location.source, backupDir, maxBackups: settings.maxBackups };
		},
		async setMatchDir(dir) {
			await saveSettings(settingsFile, { matchDirOverride: dir });
			await configure();
		},
		dispose() {
			clearTimeout(timer);
			watcher?.close();
		},
	};
}
