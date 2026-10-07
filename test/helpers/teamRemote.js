// Builds a throwaway team repository with the real git, for tests. Nothing
// here touches the network, GitHub, or the git settings of the person
// running the tests: every call uses a settings file made for the test.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGit } from '../../core/git.js';

// The environment for every git call in a test. With `identity: false`, git
// has no name or email to commit under.
export function gitEnv(root, { identity = true } = {}) {
	const config = path.join(root, identity ? 'gitconfig' : 'gitconfig-anonymous');
	if (!fs.existsSync(config)) {
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(
			config,
			identity
				? '[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n'
				: '[user]\n\tuseConfigOnly = true\n[init]\n\tdefaultBranch = main\n'
		);
	}
	return { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
}

// Git as the app is given it in a test, kept away from the network.
//
// A test's repositories are folders on this computer. Where a test gives the
// app an address on GitHub, `behind` says which folder stands behind it, and
// git is handed that folder in its place. Any other address stops here,
// before git is called. So if a check in the app that should have refused an
// address ever gave way, the test that leans on it fails, and nothing is
// asked of a real server.
export function offline(real, behind = new Map()) {
	const git = (args, options) => {
		const stray = args.find((arg) => typeof arg === 'string' && /^(https?:|ssh:|git@)/i.test(arg) && !behind.has(arg));
		if (stray) return Promise.reject(new Error(`This test has no repository for ${stray}.`));
		return real(args.map((arg) => behind.get(arg) ?? arg), options);
	};
	git.stopAll = () => real.stopAll?.();
	return git;
}

// The real git for a test, with its own settings file under `root`, and the
// guard above around it. Every test that hands the app a git gets it here.
export const localGit = (root, behind, options) => offline(createGit({ allowLocal: true, env: gitEnv(root, options) }), behind);

export function createRemote(root = fs.mkdtempSync(path.join(os.tmpdir(), 'snippet-editor-remote-'))) {
	const env = gitEnv(root);
	const url = path.join(root, 'remote.git');
	const seed = path.join(root, 'seed');
	const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

	git(root, 'init', '--quiet', '--bare', '--initial-branch=main', url);
	git(root, 'clone', '--quiet', url, seed);

	return {
		root,
		url,
		env,
		// Writes files (text or bytes are its content, null removes it, { link }
		// makes a symbolic link), commits and pushes. Returns the commit.
		commit(files, message = 'Change') {
			for (const [name, content] of Object.entries(files)) {
				const file = path.join(seed, name);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.rmSync(file, { recursive: true, force: true });
				if (content === null) continue;
				if (typeof content === 'object' && !Buffer.isBuffer(content)) fs.symlinkSync(content.link, file);
				else fs.writeFileSync(file, content);
			}
			git(seed, 'add', '--all');
			git(seed, 'commit', '--quiet', '--allow-empty', '-m', message);
			git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
			return git(seed, 'rev-parse', 'HEAD');
		},
		// Adds a submodule entry without fetching anything.
		addSubmodule(name) {
			git(seed, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},${name}`);
			git(seed, 'commit', '--quiet', '-m', 'Add a submodule');
			git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
		},
		// Adds one entry straight into the commit, without a file on this
		// computer's disk. So two names that differ only in capitals can both
		// exist, as they can in a repository made on another system.
		addEntry(name, content, mode = '100644') {
			const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: seed, env, input: content, encoding: 'utf8' }).trim();
			git(seed, 'update-index', '--add', '--cacheinfo', `${mode},${blob},${name}`);
			git(seed, 'commit', '--quiet', '-m', `Add ${name}`);
			git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
		},
		// The team renames its main branch.
		renameDefault(name) {
			git(seed, 'branch', '-m', name);
			git(seed, 'commit', '--quiet', '--allow-empty', '-m', `Now on ${name}`);
			git(seed, 'push', '--quiet', 'origin', name);
			git(url, 'symbolic-ref', 'HEAD', `refs/heads/${name}`);
			git(url, 'update-ref', '-d', 'refs/heads/main');
			return git(seed, 'rev-parse', 'HEAD');
		},
		// The team rewrites history on the main branch.
		rewrite(message = 'Rewritten') {
			git(seed, 'commit', '--quiet', '--amend', '--allow-empty', '-m', message);
			git(seed, 'push', '--quiet', '--force', 'origin', 'HEAD:main');
			return git(seed, 'rev-parse', 'HEAD');
		},
		head: (ref = 'main') => git(url, 'rev-parse', ref),
		branches: () => git(url, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort(),
		show: (ref, file) => git(url, 'show', `${ref}:${file}`),
		log: (ref) => git(url, 'log', '--format=%an <%ae>|%s', ref).split('\n'),
		filesIn: (ref, folder) => git(url, 'ls-tree', '-r', '--name-only', ref, folder).split('\n').filter(Boolean),
		// The repository can be read but refuses every new proposal branch.
		refuseProposals: () => git(url, 'config', 'receive.hideRefs', 'refs/heads/snippet-editor'),
	};
}

export const MANIFEST = (name, extra = {}) =>
	Object.entries({ name, title: `${name[0].toUpperCase()}${name.slice(1)}`, description: `The ${name} package`, version: '0.1.0', author: 'Team Lead', ...extra })
		.map(([key, value]) => `${key}: ${value}\n`)
		.join('');

export const MATCHES = (...pairs) => 'matches:\n' + pairs.map(([trigger, replace]) => `  - trigger: "${trigger}"\n    replace: "${replace}"\n`).join('');

// A repository with two ordinary packages, as most tests want.
export function seeded(root) {
	const remote = createRemote(root);
	remote.commit(
		{
			'README.md': '# Team snippets\n',
			'packages/goodbyes/_manifest.yml': MANIFEST('goodbyes'),
			'packages/goodbyes/package.yml': MATCHES([':bye', 'Goodbye for now'], [':cheers', 'Cheers,']),
			'packages/support/_manifest.yml': MANIFEST('support', { title: 'Support replies', version: '1.2.0' }),
			'packages/support/replies.yml': MATCHES([':refund', 'Your refund is on its way.']),
			'packages/support/escalations.yml': MATCHES([':esc', 'I am escalating this.'], [':esc2', 'This is now with a specialist.'], [':esc3', 'A specialist will reply.']),
		},
		'Seed'
	);
	return remote;
}
