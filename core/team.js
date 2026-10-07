import { PACKAGE_NAME, createTeamRepo } from './teamRepo.js';

// The team repository and the installed copies, joined: what is on offer,
// what is installed, and what has changed since it was installed.

const fail = (code, message) => Object.assign(new Error(message), { code });

// `installed` is a function, not a value: the match folder can change while a
// repository stays connected, and installs must follow it.
export function createTeam({ dataDir, address, git, installed, limits }) {
	const repo = createTeamRepo({ dataDir, address, git, limits });
	// The last thing that went wrong reaching the repository, if it still holds.
	let problem = '';
	// Set once this repository is being disconnected. A fetch asked for after
	// that would otherwise wait its turn behind the disconnect, find no copy,
	// and make one again.
	let leaving = false;

	// Always answers. If git or the copy fails here, the repository is still
	// the connected one: the answer says what went wrong and lists nothing, so
	// the window can show it and offer to disconnect.
	async function status() {
		const copies = installed();
		const markers = await copies.installed();
		// A package belongs to the repository its marker names. '' means the
		// marker names none: it is damaged.
		const holderOf = (marker) => copies.keyOf(marker.repository);
		let state = { branch: null, commit: null, fetchedAt: null };
		let listed = { packages: [], problems: [] };
		let trouble = problem;
		try {
			state = await repo.status();
			if (state.branch !== null) listed = await repo.packages();
		} catch (error) {
			trouble = error.message;
		}
		const offered = new Set(listed.packages.map((pkg) => pkg.name));
		return {
			connected: true,
			repository: address.url,
			webUrl: address.webUrl,
			...state,
			problem: trouble,
			problems: listed.problems,
			packages: listed.packages.map((pkg) => {
				const marker = markers.get(pkg.name);
				const holder = marker ? holderOf(marker) : '';
				// A damaged marker counts as this repository's, and as every other's
				// that offers the name: whichever installs it again repairs it.
				const own = Boolean(marker) && (holder === '' || holder === address.key);
				return {
					...pkg,
					installed: own,
					// An install that was cut short counts as out of date: installing
					// again is what finishes it.
					updateAvailable: own && (holder === '' || marker.state !== 'installed' || marker.tree !== pkg.tree),
					// The name is taken: another repository's package is installed under it.
					installedFrom: marker && !own ? marker.repository : '',
				};
			}),
			// Its own packages that it no longer offers. Another repository's are
			// that repository's to list.
			installedOnly: [...markers].filter(([name, marker]) => !offered.has(name) && holderOf(marker) === address.key).map(([name]) => ({ name })),
		};
	}

	const reaching = async (work) => {
		try {
			if (leaving) throw fail('NOT_CONNECTED', 'That repository is being disconnected.');
			await work();
			problem = '';
		} catch (error) {
			problem = error.message;
			throw error;
		}
	};

	return {
		address,
		status,
		connect: () => reaching(() => repo.connect()),
		// `connect` fetches when the copy is there, and makes it again when it has gone.
		refresh: async () => (await reaching(() => repo.connect()), status()),
		// At start: the window must open whether or not the repository answers.
		refreshQuietly: () => reaching(() => repo.connect()).catch(() => {}),

		async install(name, { acceptCommands } = {}) {
			if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) throw fail('INVALID', 'A package name is lowercase letters, digits and dashes, 80 characters or fewer.');
			// A name another repository holds is refused here, before any file is
			// read. The installed copies ask again as they write.
			await installed().checkFree(name, address.url);
			const { commit, package: pkg, files } = await repo.packageFiles(name);
			if (pkg.matchCount === null) throw fail('INVALID', 'This package was not read, so it cannot be installed from here.');
			if (pkg.runsCommands && acceptCommands !== true) {
				throw fail('INVALID', 'This package runs commands on your computer when its snippets are used. Send `acceptCommands: true` to install it.');
			}
			await installed().install({ name, files, repository: address.url, commit, tree: pkg.tree });
			return status();
		},

		propose: (input) => repo.propose(input),
		async disconnect() {
			leaving = true;
			try {
				await repo.disconnect();
			} catch (error) {
				// The copy is still there, so the repository is still connected.
				leaving = false;
				throw error;
			}
		},
	};
}
