import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit } from '../core/git.js';
import { parseRepositoryAddress } from '../core/teamAddress.js';
import { createTeamRepo } from '../core/teamRepo.js';
import { MANIFEST, MATCHES, createRemote, gitEnv, seeded } from './helpers/teamRemote.js';

function setup({ remote = seeded(), identity = true, limits, now } = {}) {
	const dataDir = mkdtempSync(join(tmpdir(), 'snippet-editor-team-'));
	const git = createGit({ allowLocal: true, env: gitEnv(remote.root, { identity }) });
	const address = parseRepositoryAddress(remote.url, { allowLocal: true });
	const repo = createTeamRepo({ dataDir, address, git, limits, now });
	return { remote, dataDir, git, address, repo };
}

const bytes = (text) => Buffer.byteLength(text);

const rejectsWith = async (promise, check) => {
	let caught;
	await promise.catch((error) => (caught = error));
	assert.ok(caught, 'expected a failure');
	check(caught);
	return caught;
};

// --- reading --------------------------------------------------------------------

test('connecting copies the repository and lists its packages', async () => {
	const { repo, remote } = setup();
	await repo.connect();
	const status = await repo.status();
	assert.deepEqual([status.branch, status.commit], ['main', remote.head()]);
	assert.match(status.fetchedAt, /^\d{4}-\d\d-\d\dT/);

	const { packages, problems } = await repo.packages();
	assert.deepEqual(problems, []);
	assert.deepEqual(
		packages.map(({ tree, ...rest }) => rest),
		[
			{
				name: 'goodbyes',
				title: 'Goodbyes',
				description: 'The goodbyes package',
				version: '0.1.0',
				author: 'Team Lead',
				manifestError: '',
				files: [{ name: 'package.yml', matchCount: 2, size: bytes(MATCHES([':bye', 'Goodbye for now'], [':cheers', 'Cheers,'])) }],
				matchCount: 2,
				runsCommands: false,
				problems: [],
				webUrl: null,
			},
			{
				name: 'support',
				title: 'Support replies',
				description: 'The support package',
				version: '1.2.0',
				author: 'Team Lead',
				manifestError: '',
				files: [
					{ name: 'escalations.yml', matchCount: 3, size: bytes(MATCHES([':esc', 'I am escalating this.'], [':esc2', 'This is now with a specialist.'], [':esc3', 'A specialist will reply.'])) },
					{ name: 'replies.yml', matchCount: 1, size: bytes(MATCHES([':refund', 'Your refund is on its way.'])) },
				],
				matchCount: 4,
				runsCommands: false,
				problems: [],
				webUrl: null,
			},
		]
	);
	assert.match(packages[0].tree, /^[a-f0-9]{40}$/);
});

test('a web address is given for each package when the repository has one', async () => {
	const { remote, dataDir, git } = setup();
	const address = { ...parseRepositoryAddress(remote.url, { allowLocal: true }), webUrl: 'https://github.com/acme/team' };
	const repo = createTeamRepo({ dataDir, address, git });
	await repo.connect();
	assert.equal((await repo.packages()).packages[0].webUrl, 'https://github.com/acme/team/tree/main/packages/goodbyes');
});

test('the files of a package come back as bytes, manifest included', async () => {
	const { repo } = setup();
	await repo.connect();
	const { commit, package: described, files } = await repo.packageFiles('support');
	assert.deepEqual([commit, described.name, described.matchCount], [(await repo.status()).commit, 'support', 4]);
	assert.deepEqual(files.map((file) => file.name), ['_manifest.yml', 'escalations.yml', 'replies.yml']);
	assert.equal(files[2].bytes.toString('utf8'), MATCHES([':refund', 'Your refund is on its way.']));
	await rejectsWith(repo.packageFiles('nothing'), (error) => assert.equal(error.code, 'NOT_FOUND'));
});

test('fetching picks up a new commit, and a tree changes only for the package that changed', async () => {
	const { repo, remote } = setup();
	await repo.connect();
	const before = Object.fromEntries((await repo.packages()).packages.map((pkg) => [pkg.name, pkg.tree]));
	const commit = remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Goodbye, and thank you']) });
	assert.notEqual((await repo.status()).commit, commit);
	await repo.fetch();
	assert.equal((await repo.status()).commit, commit);
	const after = Object.fromEntries((await repo.packages()).packages.map((pkg) => [pkg.name, pkg.tree]));
	assert.notEqual(after.goodbyes, before.goodbyes);
	assert.equal(after.support, before.support);
});

test('connecting again fetches, and does not clone twice', async () => {
	const { repo, remote, dataDir } = setup();
	await Promise.all([repo.connect(), repo.connect()]);
	const commit = remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Later']) });
	await repo.connect();
	assert.equal((await repo.status()).commit, commit);
	const [folder] = readdirSync(join(dataDir, 'team'));
	assert.deepEqual(readdirSync(join(dataDir, 'team', folder)).sort(), ['fetched-at', 'repo.git']);
});

test('leftovers from a connection that was cut short are removed', async () => {
	const { repo, dataDir } = setup();
	await repo.connect();
	const [folder] = readdirSync(join(dataDir, 'team'));
	const dir = join(dataDir, 'team', folder);
	mkdirSync(join(dir, 'repo.git.tmp-deadbeef'));
	mkdirSync(join(dir, 'work-deadbeef', 'packages'), { recursive: true });
	await repo.connect();
	assert.deepEqual(readdirSync(dir).sort(), ['fetched-at', 'repo.git']);
});

test('before connecting, the status is empty and listing says so', async () => {
	const { repo } = setup();
	assert.deepEqual(await repo.status(), { branch: null, commit: null, fetchedAt: null });
	await rejectsWith(repo.packages(), (error) => assert.equal(error.code, 'NOT_CONNECTED'));
});

test('an empty repository, and one with no packages folder, list nothing and say why', async () => {
	const empty = setup({ remote: createRemote() });
	await empty.repo.connect();
	assert.deepEqual(await empty.repo.packages(), { packages: [], problems: ['This repository is empty.'] });
	assert.equal((await empty.repo.status()).commit, null);

	const bare = createRemote();
	bare.commit({ 'README.md': '# Nothing yet\n' });
	const plain = setup({ remote: bare });
	await plain.repo.connect();
	assert.deepEqual(await plain.repo.packages(), { packages: [], problems: ['This repository has no packages folder yet.'] });
});

test('a package with a missing or unreadable manifest is still listed, named from its folder', async () => {
	const remote = createRemote();
	remote.commit({
		'packages/no-manifest/package.yml': MATCHES([':a', 'A']),
		'packages/bad-yaml/_manifest.yml': 'title: "open\n',
		'packages/bad-yaml/package.yml': MATCHES([':b', 'B']),
		'packages/not-a-mapping/_manifest.yml': '- one\n- two\n',
		'packages/not-a-mapping/package.yml': MATCHES([':c', 'C']),
	});
	const { repo } = setup({ remote });
	await repo.connect();
	const byName = Object.fromEntries((await repo.packages()).packages.map((pkg) => [pkg.name, pkg]));
	assert.deepEqual([byName['no-manifest'].title, byName['no-manifest'].manifestError, byName['no-manifest'].matchCount], ['no-manifest', 'It has no _manifest.yml.', 1]);
	assert.equal(byName['bad-yaml'].title, 'bad-yaml');
	assert.match(byName['bad-yaml'].manifestError, /^Its manifest could not be read: /);
	assert.equal(byName['not-a-mapping'].manifestError, 'Its manifest is not a list of keys and values.');
});

test('what cannot be installed safely is left out and reported', async () => {
	const remote = createRemote();
	remote.commit({
		'packages/mixed/_manifest.yml': MANIFEST('mixed'),
		'packages/mixed/package.yml': MATCHES([':ok', 'fine']),
		'packages/mixed/linked.yml': { link: '/etc/hosts' },
		'packages/mixed/big.yml': MATCHES([':big', 'x'.repeat(2000)]),
		'packages/mixed/broken.yml': 'matches:\n  - trigger: "open\n',
		'packages/mixed/.hidden.yml': MATCHES([':hidden', 'h']),
		'packages/mixed/nested/deep.yml': MATCHES([':deep', 'd']),
		'packages/mixed/notes.md': 'Not a match file.\n',
		'packages/Bad_Name/package.yml': MATCHES([':bad', 'b']),
		'packages/linked-package': { link: '../README.md' },
		'packages/stray.yml': MATCHES([':stray', 's']),
		'README.md': '# Team\n',
	});
	remote.addSubmodule('packages/mixed/vendored');
	const { repo } = setup({ remote, limits: { fileBytes: 1024 } });
	await repo.connect();
	const { packages, problems } = await repo.packages();
	assert.deepEqual(packages.map((pkg) => pkg.name), ['mixed']);
	assert.deepEqual(problems, ['Bad_Name was left out: that is not a package name.', 'linked-package was left out: it is a link.']);
	const [mixed] = packages;
	assert.deepEqual(mixed.files, [
		{ name: 'broken.yml', matchCount: null, size: bytes('matches:\n  - trigger: "open\n') },
		{ name: 'package.yml', matchCount: 1, size: bytes(MATCHES([':ok', 'fine'])) },
	]);
	assert.equal(mixed.matchCount, 1);
	assert.deepEqual(mixed.problems, [
		'.hidden.yml was left out: that is not a match file name.',
		'big.yml was left out: it is larger than the app opens.',
		'broken.yml has YAML errors.',
		'linked.yml was left out: it is a link.',
		'Subfolders were left out.',
		'vendored was left out: it is a submodule.',
	]);
	// Nothing left out is handed over for install either.
	assert.deepEqual((await repo.packageFiles('mixed')).files.map((file) => file.name), ['_manifest.yml', 'broken.yml', 'package.yml']);
});

test('lists are cut at their limits, and say so', async () => {
	const remote = createRemote();
	const files = {};
	for (const name of ['a', 'b', 'c']) {
		files[`packages/${name}/_manifest.yml`] = MANIFEST(name);
		for (const part of ['1', '2', '3']) files[`packages/${name}/part${part}.yml`] = MATCHES([`:${name}${part}`, 'x']);
	}
	remote.commit(files);
	const { repo } = setup({ remote, limits: { packages: 2, files: 2 } });
	await repo.connect();
	const { packages, problems } = await repo.packages();
	assert.deepEqual(packages.map((pkg) => pkg.name), ['a', 'b']);
	assert.deepEqual(problems, ['Only the first 2 packages are shown.']);
	assert.deepEqual(packages[0].files.map((file) => file.name), ['part1.yml', 'part2.yml']);
	assert.deepEqual(packages[0].problems, ['Only the first 2 files are included.']);

	const tight = setup({ remote, limits: { totalBytes: 150 } });
	await tight.repo.connect();
	const listed = (await tight.repo.packages()).packages;
	assert.equal(listed[0].matchCount, 3);
	assert.deepEqual([listed[2].matchCount, listed[2].problems], [null, ['Not read: the repository holds more than the app reads at once.']]);
});

test('a package that can run commands is marked', async () => {
	const remote = createRemote();
	const withVar = (type) => `matches:\n  - trigger: ":x"\n    replace: "{{out}}"\n    vars:\n      - name: out\n        type: ${type}\n        params:\n          cmd: "echo hi"\n`;
	remote.commit({
		'packages/shell/_manifest.yml': MANIFEST('shell'),
		'packages/shell/package.yml': withVar('shell'),
		'packages/script/_manifest.yml': MANIFEST('script'),
		'packages/script/package.yml': MATCHES([':plain', 'p']),
		'packages/script/extra.yml': withVar('script'),
		'packages/global/_manifest.yml': MANIFEST('global'),
		'packages/global/package.yml': `global_vars:\n  - name: who\n    type: shell\n    params:\n      cmd: whoami\n${MATCHES([':g', '{{who}}'])}`,
		'packages/plain/_manifest.yml': MANIFEST('plain'),
		'packages/plain/package.yml': withVar('date'),
		'packages/wordy/_manifest.yml': MANIFEST('wordy'),
		'packages/wordy/package.yml': MATCHES([':w', 'type: shell is only text here']),
	});
	const { repo } = setup({ remote });
	await repo.connect();
	const runs = Object.fromEntries((await repo.packages()).packages.map((pkg) => [pkg.name, pkg.runsCommands]));
	assert.deepEqual(runs, { global: true, plain: false, script: true, shell: true, wordy: false });
});

test('a repository that is not there cannot be connected, and leaves nothing behind', async () => {
	const { dataDir, git } = setup();
	const address = parseRepositoryAddress(join(dataDir, 'nowhere.git'), { allowLocal: true });
	const repo = createTeamRepo({ dataDir, address, git });
	await rejectsWith(repo.connect(), (error) => assert.deepEqual([error.code, error.kind], ['GIT_FAILED', 'unreachable']));
	assert.deepEqual(await repo.status(), { branch: null, commit: null, fetchedAt: null });
	const folders = readdirSync(join(dataDir, 'team'));
	for (const folder of folders) assert.deepEqual(readdirSync(join(dataDir, 'team', folder)), []);
});

test('disconnecting removes the copy', async () => {
	const { repo, dataDir } = setup();
	await repo.connect();
	await repo.disconnect();
	assert.deepEqual(readdirSync(join(dataDir, 'team')), []);
	assert.deepEqual(await repo.status(), { branch: null, commit: null, fetchedAt: null });
});

test('work asked for at the same moment runs one piece at a time', async () => {
	const { repo, remote } = setup();
	await repo.connect();
	remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'One at a time']) });
	const [, listed, , { files }] = await Promise.all([repo.fetch(), repo.packages(), repo.fetch(), repo.packageFiles('goodbyes')]);
	assert.equal(listed.packages.length, 2);
	assert.equal(files[1].bytes.toString('utf8'), MATCHES([':bye', 'One at a time']));
});

// --- proposing ------------------------------------------------------------------

const AT = () => new Date(Date.UTC(2026, 9, 6, 10, 15, 0));
const BRANCH = 'snippet-editor/goodbyes-20261006-101500';
const FAREWELLS = MATCHES([':farewell', 'Farewell, and thank you.']);

// Nothing of a proposal may stay in the app's copy: no branch, no folder.
async function leftBehind({ dataDir, git }) {
	const [folder] = readdirSync(join(dataDir, 'team'));
	const dir = join(dataDir, 'team', folder);
	const refs = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: join(dir, 'repo.git') })).trim().split('\n');
	return { folders: readdirSync(dir).filter((name) => name.startsWith('work-')), branches: refs.filter((ref) => ref !== 'main') };
}

test('a proposal arrives as one commit on a new branch, and the main branch is untouched', async () => {
	const context = setup({ now: AT });
	const { repo, remote } = context;
	await repo.connect();
	const main = remote.head();
	const result = await repo.propose({ package: 'goodbyes', fileName: 'farewells.yml', text: FAREWELLS, summary: 'Add farewells' });

	assert.deepEqual(result, { branch: BRANCH, commit: remote.head(BRANCH), created: false, compareUrl: null });
	assert.equal(remote.head(), main);
	assert.deepEqual(remote.branches(), ['main', BRANCH]);
	assert.equal(remote.head(`${BRANCH}~1`), main);
	assert.deepEqual(remote.log(BRANCH).slice(0, 1), ['Test Person <test@example.com>|Add farewells']);
	assert.deepEqual(remote.filesIn(BRANCH, 'packages/goodbyes'), ['packages/goodbyes/_manifest.yml', 'packages/goodbyes/farewells.yml', 'packages/goodbyes/package.yml']);
	assert.equal(remote.show(BRANCH, 'packages/goodbyes/farewells.yml') + '\n', FAREWELLS);
	assert.deepEqual(await leftBehind(context), { folders: [], branches: [] });
});

test('a proposal starts from the newest commit, and links to the pull request page when there is a web address', async () => {
	const { remote, dataDir, git } = setup();
	const address = { ...parseRepositoryAddress(remote.url, { allowLocal: true }), webUrl: 'https://github.com/acme/team' };
	const repo = createTeamRepo({ dataDir, address, git, now: AT });
	await repo.connect();
	const newer = remote.commit({ 'packages/support/replies.yml': MATCHES([':refund', 'Refund sent.']) });
	const result = await repo.propose({ package: 'goodbyes', fileName: 'farewells.yml', text: FAREWELLS, summary: 'Add farewells' });
	assert.equal(remote.head(`${BRANCH}~1`), newer);
	assert.equal(result.compareUrl, `https://github.com/acme/team/compare/main...${BRANCH}?expand=1`);
});

test('a proposal for a package that does not exist yet writes its manifest', async () => {
	const { repo, remote } = setup({ now: AT });
	await repo.connect();
	const input = { package: 'farewells', fileName: 'package.yml', text: FAREWELLS, summary: 'Start a farewells package' };
	for (const [extra, field] of [
		[{}, 'title'],
		[{ title: 'Farewells' }, 'description'],
		[{ title: 'Farewells', description: 'No' }, 'description'],
		[{ title: 'Farewells', description: 'x'.repeat(1001) }, 'description'],
		[{ title: 'Two\nlines', description: 'Ways to say goodbye' }, 'title'],
	]) {
		await rejectsWith(repo.propose({ ...input, ...extra }), (error) => {
			assert.equal(error.code, 'INVALID');
			assert.match(error.message, new RegExp(`\`${field}\``));
		});
	}
	assert.deepEqual(remote.branches(), ['main']);

	const result = await repo.propose({ ...input, title: 'Farewells: "kind" ones', description: 'Ways to say goodbye' });
	assert.equal(result.created, true);
	const branch = 'snippet-editor/farewells-20261006-101500';
	assert.equal(
		remote.show(branch, 'packages/farewells/_manifest.yml') + '\n',
		'name: farewells\ntitle: \'Farewells: "kind" ones\'\ndescription: Ways to say goodbye\nversion: 0.1.0\nauthor: Test Person\n'
	);
	assert.deepEqual(remote.filesIn(branch, 'packages/farewells'), ['packages/farewells/_manifest.yml', 'packages/farewells/package.yml']);
});

test('a file the package already holds can be replaced, but not proposed unchanged', async () => {
	const { repo, remote } = setup({ now: AT });
	await repo.connect();
	const current = MATCHES([':bye', 'Goodbye for now'], [':cheers', 'Cheers,']);
	await rejectsWith(repo.propose({ package: 'goodbyes', fileName: 'package.yml', text: current, summary: 'Nothing new' }), (error) => {
		assert.equal(error.code, 'INVALID');
		assert.equal(error.message, 'The team package already has this file as it is.');
	});
	assert.deepEqual(remote.branches(), ['main']);
	const changed = MATCHES([':bye', 'Goodbye, and thanks'], [':cheers', 'Cheers,']);
	await repo.propose({ package: 'goodbyes', fileName: 'package.yml', text: changed, summary: 'Warmer goodbye' });
	assert.equal(remote.show(BRANCH, 'packages/goodbyes/package.yml') + '\n', changed);
});

test('what is asked for is checked before git is involved', async () => {
	const { repo, remote } = setup({ now: AT });
	await repo.connect();
	const good = { package: 'goodbyes', fileName: 'farewells.yml', text: FAREWELLS, summary: 'Add farewells' };
	for (const bad of [
		{ package: 'Good_Byes' },
		{ package: '../escape' },
		{ package: '' },
		{ fileName: '../farewells.yml' },
		{ fileName: 'farewells.txt' },
		{ fileName: '.hidden.yml' },
		{ fileName: '_manifest.yml' },
		{ text: '' },
		{ text: '   \n' },
		{ text: 42 },
		{ summary: '' },
		{ summary: '   ' },
		{ summary: 'x'.repeat(101) },
		{ summary: 'Two\nlines' },
	]) {
		await rejectsWith(repo.propose({ ...good, ...bad }), (error) => assert.equal(error.code, 'INVALID', JSON.stringify(bad)));
	}
	await rejectsWith(repo.propose({ ...good, text: 'x'.repeat(3 * 1024 * 1024) }), (error) => assert.equal(error.code, 'TOO_LARGE'));
	assert.deepEqual(remote.branches(), ['main']);
});

test('without a name and email for git, the proposal fails plainly and leaves nothing behind', async () => {
	const context = setup({ identity: false, now: AT });
	await context.repo.connect();
	const error = await rejectsWith(context.repo.propose({ package: 'goodbyes', fileName: 'farewells.yml', text: FAREWELLS, summary: 'Add farewells' }), (failure) =>
		assert.deepEqual([failure.code, failure.kind], ['GIT_FAILED', 'identity'])
	);
	assert.match(error.message, /Git does not know your name and email yet/);
	assert.deepEqual(context.remote.branches(), ['main']);
	assert.deepEqual(await leftBehind(context), { folders: [], branches: [] });
});

test('a repository that refuses the push says so, and nothing is left behind', async () => {
	const context = setup({ now: AT });
	await context.repo.connect();
	context.remote.refuseProposals();
	const error = await rejectsWith(context.repo.propose({ package: 'goodbyes', fileName: 'farewells.yml', text: FAREWELLS, summary: 'Add farewells' }), (failure) =>
		assert.deepEqual([failure.code, failure.kind], ['GIT_FAILED', 'denied'])
	);
	assert.equal(error.message, 'You do not have permission to push to this repository.');
	assert.deepEqual(context.remote.branches(), ['main']);
	assert.deepEqual(await leftBehind(context), { folders: [], branches: [] });
});

test('a link in the repository is never written through', async () => {
	const remote = seeded();
	const outside = join(remote.root, 'outside');
	mkdirSync(outside);
	writeFileSync(join(outside, 'target.yml'), 'untouched\n');
	remote.commit({ 'packages/linked': { link: outside }, 'packages/goodbyes/linked.yml': { link: join(outside, 'target.yml') } });
	const context = setup({ remote, now: AT });
	await context.repo.connect();
	for (const input of [
		{ package: 'linked', fileName: 'target.yml' },
		{ package: 'linked', fileName: 'new.yml' },
		{ package: 'goodbyes', fileName: 'linked.yml' },
	]) {
		await rejectsWith(context.repo.propose({ ...input, text: FAREWELLS, summary: 'Through a link', title: 'Linked', description: 'A link' }), (error) => {
			assert.equal(error.code, 'INVALID', JSON.stringify(input));
			assert.match(error.message, /link|folder/);
		});
	}
	assert.equal(readFileSync(join(outside, 'target.yml'), 'utf8'), 'untouched\n');
	assert.deepEqual(readdirSync(outside), ['target.yml']);
	assert.deepEqual(remote.branches(), ['main']);
	assert.deepEqual(await leftBehind(context), { folders: [], branches: [] });
});

test('two proposals in the same second get two branches', async () => {
	const { repo, remote } = setup({ now: AT });
	await repo.connect();
	const [first, second] = await Promise.all([
		repo.propose({ package: 'goodbyes', fileName: 'farewells.yml', text: FAREWELLS, summary: 'Add farewells' }),
		repo.propose({ package: 'goodbyes', fileName: 'more.yml', text: MATCHES([':more', 'More']), summary: 'Add more' }),
	]);
	assert.deepEqual([first.branch, second.branch], [BRANCH, `${BRANCH}-2`]);
	assert.deepEqual(remote.branches(), ['main', BRANCH, `${BRANCH}-2`]);
});

test('an empty repository cannot take a proposal yet', async () => {
	const { repo } = setup({ remote: createRemote(), now: AT });
	await repo.connect();
	await rejectsWith(repo.propose({ package: 'goodbyes', fileName: 'farewells.yml', text: FAREWELLS, summary: 'Add farewells', title: 'Goodbyes', description: 'Ways to part' }), (error) => {
		assert.equal(error.code, 'INVALID');
		assert.match(error.message, /empty/);
	});
});
