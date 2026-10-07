import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './store.js';
import { resolveMatchDir } from './espansoPaths.js';
import { createGit } from './git.js';
import { MAX_TEAM_REPOSITORIES, loadSettings, saveSettings as writeSettings } from './settings.js';
import { createTeam } from './team.js';
import { parseRepositoryAddress } from './teamAddress.js';
import { createTeamPackages } from './teamPackages.js';

const fail = (code, message) => Object.assign(new Error(message), { code });

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
	// The connected team repositories, each under the address git is given for
	// it, in the order they were connected, which is the order of the setting.
	let teams = new Map();
	let teamPackages;
	// What was wrong with the saved list at start, if anything.
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
		// Told what counts as an address, as the repositories are: a package
		// belongs to the repository its marker names.
		teamPackages = createTeamPackages({ matchDir: location.matchDir, allowLocal: allowLocalRepositories });
		teams = new Map();
		// The settings file can be edited by hand. An address the app would
		// refuse in its own field is refused here too, and so is a repository
		// that is in the list twice. Each is skipped and the rest are loaded.
		// A refused address is named by its place and never repeated: carrying
		// a password is one of the reasons an address is refused.
		const skipped = [];
		settings.teamRepositories.forEach((saved, index) => {
			let address;
			try {
				address = parseAddress(saved);
			} catch {
				skipped.push(`Saved team repository ${index + 1} has an address the app does not accept, so it was skipped. Connect it again in Settings.`);
				return;
			}
			const same = connectedAs(address);
			if (same) skipped.push(`Saved team repository ${index + 1} is the same repository as ${same.address.url}, so it was skipped.`);
			else teams.set(address.url, teamFor(address));
		});
		teamProblem = skipped.join(' ');
		watch();
	}

	// A copy, list and all, so that a caller cannot change what the service holds.
	const settingsCopy = () => ({ ...settings, teamRepositories: [...settings.teamRepositories] });
	const parseAddress = (input) => parseRepositoryAddress(input, { allowLocal: allowLocalRepositories });
	const teamFor = (address) => createTeam({ dataDir: userDataDir, address, git, installed: () => teamPackages });
	// The connected repository an address means, whichever form it is written in.
	const connectedAs = (address) => [...teams.values()].find((team) => team.address.key === address.key);
	const noId = (id) => id === undefined || id === null;
	// One repository by its id. With no id, the one that is connected, when
	// there is exactly one: with several, which is meant has to be said.
	const teamOf = (id) => {
		const all = [...teams.values()];
		if (noId(id)) return all.length === 1 ? all[0] : null;
		return all.find((team) => team.address.id === id) ?? null;
	};

	// What the app says about team snippets: every connected repository with
	// what it offers, then the installed packages that belong to none of them.
	async function teamStatus() {
		const connected = [...teams.values()];
		const [markers, repositories] = await Promise.all([
			teamPackages.installed(),
			Promise.all(connected.map(async (team) => ({ id: team.address.id, ...(await team.status()) }))),
		]);
		const keys = new Set(connected.map((team) => team.address.key));
		const offered = new Set(repositories.flatMap((repository) => repository.packages.map((pkg) => pkg.name)));
		const installedOnly = [];
		for (const [name, marker] of markers) {
			const key = teamPackages.keyOf(marker.repository);
			// A damaged marker names no repository. Where its name is on offer, the
			// package shows there as needing an update. Otherwise it is listed
			// here, so that it can still be removed. What a marker names is by now
			// an address the app accepts, or '': never the text in its file.
			if (key ? !keys.has(key) : !offered.has(name)) installedOnly.push({ name, repository: marker.repository });
		}
		return { connected: connected.length > 0, repositories, installedOnly, problem: teamProblem };
	}

	// Connecting and disconnecting run one at a time. A second Connect while
	// the first is still copying waits, then finds the work done.
	let connecting = Promise.resolve();
	const inTurn = (work) => {
		const result = connecting.then(work);
		connecting = result.catch(() => {});
		return result;
	};

	await configure();
	// Not waited for: the window opens whether or not the repositories answer.
	// Each is fetched by itself, so one that cannot be reached holds up no
	// other, and the window is told as each one ends.
	const fetched = Promise.all([...teams.values()].map((team) => team.refreshQuietly().then(onChange))).then(() => {});

	return {
		tokenFile: path.join(userDataDir, 'api-token'),
		get store() {
			return store;
		},
		get backupDir() {
			return backupDir;
		},
		settings: settingsCopy,
		async saveSettings(patch) {
			settings = await writeSettings(settingsFile, patch);
			return settingsCopy();
		},
		async state() {
			if (!watcher) watch();
			return { ...(await store.inventory()), matchDirSource: location.source, backupDir, maxBackups: settings.maxBackups, teamConnected: teams.size > 0 };
		},
		// The connected team repositories, in the order they were connected.
		teams: () => [...teams.values()],
		// One of them, by its id, or null. With no id: the only one, or null.
		team: teamOf,
		// Ends when every fetch started at start has ended, whether or not it worked.
		teamFetched: () => fetched,
		teamStatus,
		// Removing needs no repository: an installed copy can outlive its source.
		async removeTeamPackage(name) {
			await teamPackages.remove(name);
			return teamStatus();
		},
		// Adds a repository to those connected. The copy is made first, and only
		// then is the setting written. If either fails, the list is as it was.
		// async, so that a refused address rejects like every other failure.
		async connectTeam(input) {
			const address = parseAddress(input);
			return inTurn(async () => {
				// The same address again: there is nothing to copy.
				if (teams.has(address.url)) return teamStatus();
				const same = connectedAs(address);
				if (same) throw fail('INVALID', `This repository is already connected, as ${same.address.url}.`);
				if (teams.size >= MAX_TEAM_REPOSITORIES) throw fail('INVALID', 'Ten repositories are connected. Disconnect one first.');
				const next = teamFor(address);
				try {
					await next.connect();
					settings = await writeSettings(settingsFile, { teamRepositories: [...teams.keys(), address.url] });
				} catch (error) {
					// Whatever was made for it on the way goes again.
					await next.disconnect().catch(() => {});
					throw error;
				}
				teams.set(address.url, next);
				// The list was just saved as it is now, without what was skipped.
				teamProblem = '';
				return teamStatus();
			});
		},
		// Removes one repository's copy and leaves every other alone. An id that
		// is not connected, such as one disconnected a moment ago, answers the
		// list as it is. What was installed from it stays installed.
		// async, so that a call with no id rejects like every other failure.
		async disconnectTeam(id) {
			// Which one has to be said. With no id, `team` answers the only one
			// connected. That is never what a disconnect means: an id that went
			// missing on its way here must not take a repository with it.
			if (noId(id)) throw fail('INVALID', 'No repository was named, so nothing was disconnected.');
			return inTurn(async () => {
				const leaving = teamOf(id);
				if (!leaving) return teamStatus();
				try {
					// Waits its turn behind a fetch or a proposal of that repository.
					await leaving.disconnect();
					settings = await writeSettings(settingsFile, { teamRepositories: [...teams.keys()].filter((url) => url !== leaving.address.url) });
				} catch (error) {
					// Still in the saved list, so still connected, in the place it
					// had. The one that was told to leave fetches no more, so a new
					// one stands in for it and can copy the repository again.
					teams.set(leaving.address.url, teamFor(leaving.address));
					throw error;
				}
				teams.delete(leaving.address.url);
				teamProblem = '';
				return teamStatus();
			});
		},
		// Fetches one repository, or with no id all of them at once. Asked for
		// by itself, a repository that cannot be fetched fails the call. Among
		// all, a failure is recorded on its own repository, where the status
		// shows it, and the rest are still fetched.
		async refreshTeam(id) {
			if (noId(id)) {
				await Promise.all([...teams.values()].map((team) => team.refreshQuietly()));
				return teamStatus();
			}
			const one = teamOf(id);
			if (!one) throw fail('NOT_FOUND', 'That repository is not connected.');
			// Fetches when the copy is there, and makes it again when it has gone.
			await one.connect();
			return teamStatus();
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
