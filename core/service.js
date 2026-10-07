import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './store.js';
import { resolveMatchDir } from './espansoPaths.js';
import { createGit } from './git.js';
import { loadSettings, saveSettings as writeSettings } from './settings.js';
import { NOT_CONNECTED, createTeam } from './team.js';
import { parseRepositoryAddress } from './teamAddress.js';
import { createTeamPackages } from './teamPackages.js';

// The app's working parts with no window attached: the store for the current
// match folder, the settings, and a watcher that reports when Espanso's files
// change underneath. The window, the HTTP API and the tests all start here.
//
// `git` and `allowLocalRepositories` exist for tests, which point the app at
// a repository in a temporary folder. The app itself passes neither.
export async function createService({ userDataDir, env = process.env, onChange = () => {}, git = createGit(), allowLocalRepositories = false }) {
	const settingsFile = path.join(userDataDir, 'settings.json');
	let backupDir;
	let location;
	let settings;
	let store;
	let team = null;
	let teamPackages;
	let teamProblem = '';
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
		teamPackages = createTeamPackages({ matchDir: location.matchDir });
		team = null;
		teamProblem = '';
		// The setting is a list. Until the service holds several, it uses the first.
		const [saved] = settings.teamRepositories;
		if (saved) {
			try {
				team = teamFor(parseRepositoryAddress(saved, { allowLocal: allowLocalRepositories }));
			} catch {
				// The settings file can be edited by hand. An address the app would
				// refuse in its own field is refused here too.
				teamProblem = 'The saved team repository address is not one the app accepts. Connect it again in Settings.';
			}
		}
		watch();
	}

	const teamFor = (address) => createTeam({ dataDir: userDataDir, address, git, installed: () => teamPackages });

	// Connecting and disconnecting run one at a time. A second Connect while
	// the first is still copying waits, then finds the work done.
	let connecting = Promise.resolve();
	const inTurn = (work) => {
		const result = connecting.then(work);
		connecting = result.catch(() => {});
		return result;
	};

	await configure();
	// Not waited for: the window opens whether or not the repository answers.
	const fetched = team ? team.refreshQuietly().then(onChange) : Promise.resolve();

	return {
		tokenFile: path.join(userDataDir, 'api-token'),
		get store() {
			return store;
		},
		get backupDir() {
			return backupDir;
		},
		settings: () => ({ ...settings }),
		async saveSettings(patch) {
			settings = await writeSettings(settingsFile, patch);
			return { ...settings };
		},
		async state() {
			if (!watcher) watch();
			return { ...(await store.inventory()), matchDirSource: location.source, backupDir, maxBackups: settings.maxBackups, teamConnected: team !== null };
		},
		// The connected team repository, or null.
		team: () => team,
		teamFetched: () => fetched,
		async teamStatus() {
			if (team) return team.status();
			const markers = await teamPackages.installed();
			return { ...NOT_CONNECTED, problem: teamProblem, installedOnly: [...markers.keys()].map((name) => ({ name })) };
		},
		// Removing needs no repository: an installed copy can outlive its source.
		async removeTeamPackage(name) {
			await teamPackages.remove(name);
			return this.teamStatus();
		},
		// The copy is made first. If that fails, the settings and any earlier
		// connection are left as they were.
		// async, so that a refused address rejects like every other failure.
		async connectTeam(input) {
			const address = parseRepositoryAddress(input, { allowLocal: allowLocalRepositories });
			return inTurn(async () => {
				const next = team?.address.url === address.url ? team : teamFor(address);
				await next.connect();
				if (team && team !== next) await team.disconnect();
				settings = await writeSettings(settingsFile, { teamRepositories: [address.url] });
				team = next;
				teamProblem = '';
				return team.status();
			});
		},
		disconnectTeam() {
			return inTurn(async () => {
				await team?.disconnect();
				settings = await writeSettings(settingsFile, { teamRepositories: [] });
				team = null;
				teamProblem = '';
				return this.teamStatus();
			});
		},
		async setMatchDir(dir) {
			await writeSettings(settingsFile, { matchDirOverride: dir });
			await configure();
		},
		dispose() {
			clearTimeout(timer);
			watcher?.close();
			// A clone or a push still running would otherwise outlive the app.
			git.stopAll?.();
		},
	};
}
