import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../core/apiRouter.js';
import { createService } from '../core/service.js';
import { createTeam } from '../core/team.js';
import { parseRepositoryAddress } from '../core/teamAddress.js';
import { createTeamPackages } from '../core/teamPackages.js';
import { MANIFEST, MATCHES, createRemote, localGit, offline, seeded } from './helpers/teamRemote.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/match', import.meta.url));

// Git as the service is given it in these tests: the real one, with every
// call noted, and a way to make chosen calls wait until the test lets them go.
// It is kept off the network: an address with no test repository behind it
// is noted like any other call, and then stopped before git is called.
function watched(given) {
	const real = offline(given);
	const calls = [];
	let held = null;
	const git = (args, options) => {
		calls.push(args);
		return held?.matches(args, options) ? held.gate.then(() => real(args, options)) : real(args, options);
	};
	git.stopAll = () => real.stopAll();
	const hold = (matches) => {
		let release;
		held = { matches, gate: new Promise((resolve) => (release = resolve)) };
		return () => {
			held = null;
			release();
		};
	};
	return { git, calls, hold };
}

async function setup(t, { remote = seeded(), userDataDir } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const matchDir = join(root, 'match');
	cpSync(FIXTURES, matchDir, { recursive: true });
	const { git, calls, hold } = watched(localGit(remote.root));
	const start = async (dataDir = userDataDir ?? join(root, 'data')) => {
		const service = await createService({ userDataDir: dataDir, env: { SNIPPET_EDITOR_MATCH_DIR: matchDir }, git, allowLocalRepositories: true });
		t.after(() => service.dispose());
		const handle = createRouter({ service, log: () => {} });
		return { service, call: (method, path, extra = {}) => handle({ method, path: `/api/v1${path}`, ...extra }) };
	};
	// The folders the app keeps its copies in, one per connected repository.
	const copies = (dataDir = join(root, 'data')) => (existsSync(join(dataDir, 'team')) ? readdirSync(join(dataDir, 'team')).sort() : []);
	return { root, matchDir, remote, start, calls, hold, copies, ...(await start()) };
}

const code = (reply) => [reply.status, reply.body?.error?.code];
const named = (packages) => Object.fromEntries(packages.map((pkg) => [pkg.name, pkg]));
const fails = async (promise, check) => {
	let caught;
	await promise.catch((error) => (caught = error));
	assert.ok(caught, 'expected a failure');
	check(caught);
};

// For work that must not wait behind a call the test is holding back. If it
// does wait, the test fails here, where otherwise it would never end.
const soon = (promise, what) =>
	Promise.race([promise, new Promise((resolve, reject) => setTimeout(() => reject(new Error(`${what} did not finish while another repository was held up`)), 10_000).unref())]);

const idOf = (remote) => parseRepositoryAddress(remote.url, { allowLocal: true }).id;
// The status of one repository, when one is all that is connected.
const only = (status) => {
	assert.equal(status.repositories.length, 1, 'expected one connected repository');
	return status.repositories[0];
};
// The status of one repository among several.
const of = (status, remote) => status.repositories.find((repository) => repository.id === idOf(remote));
// A repository with its own packages, each of one file. Without any, it is empty.
function another(packages = {}) {
	const remote = createRemote();
	const files = Object.entries(packages).flatMap(([name, text]) => [[`packages/${name}/_manifest.yml`, MANIFEST(name)], [`packages/${name}/package.yml`, text]]);
	if (files.length) remote.commit(Object.fromEntries(files), 'Seed');
	return remote;
}
const OTHER = { other: MATCHES([':o', 'Other']) };
const REFUSED = (place) => `Saved team repository ${place} has an address the app does not accept, so it was skipped. Connect it again in Settings.`;
const REPEATED = (place, url) => `Saved team repository ${place} is the same repository as ${url}, so it was skipped.`;

test('with no repository connected, the status says so, a team route that needs one is 409, and one that names one is 404', async (t) => {
	const { call, service, calls } = await setup(t);
	const status = await call('GET', '/team');
	assert.deepEqual([status.status, status.body], [200, { connected: false, repositories: [], installedOnly: [], problem: '' }]);
	assert.deepEqual(await service.teamStatus(), status.body);
	assert.deepEqual([service.teams(), service.team(), service.team('0123456789ab')], [[], null, null]);
	const none = { status: 409, body: { error: { code: 'NOT_CONNECTED', message: 'No team repository is connected. Connect one in the app, under Settings.' } } };
	const proposal = { fileId: 'local:base.yml', package: 'goodbyes', summary: 'x' };
	assert.deepEqual(await call('POST', '/team/refresh'), none);
	assert.deepEqual(await call('PUT', '/team/packages/goodbyes/installed', { body: {} }), none);
	assert.deepEqual(await call('PUT', '/team/packages/goodbyes/installed'), none);
	assert.deepEqual(await call('POST', '/team/proposals', { body: proposal }), none);
	// A repository that is named is looked for, and is not there.
	const gone = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'That repository is not connected.' } } };
	assert.deepEqual(await call('POST', '/team/repositories/0123456789ab/refresh'), gone);
	assert.deepEqual(await call('PUT', '/team/packages/goodbyes/installed', { body: { repository: '0123456789ab' } }), gone);
	assert.deepEqual(await call('POST', '/team/proposals', { body: { ...proposal, repository: '0123456789ab' } }), gone);
	assert.deepEqual(calls, []);
});

test('connecting saves the address and lists the packages', async (t) => {
	const { service, call, remote, copies } = await setup(t);
	const answered = await service.connectTeam(remote.url);
	assert.deepEqual(service.settings().teamRepositories, [remote.url]);
	const { body } = await call('GET', '/team');
	// Connecting answers what the status route answers: every connected repository.
	assert.deepEqual(answered, body);
	assert.deepEqual([body.connected, body.installedOnly, body.problem, body.repositories.length], [true, [], '', 1]);
	const [repository] = body.repositories;
	assert.deepEqual(Object.keys(repository).sort(), ['branch', 'commit', 'connected', 'fetchedAt', 'id', 'installedOnly', 'packages', 'problem', 'problems', 'repository', 'webUrl']);
	assert.deepEqual(
		[repository.connected, repository.repository, repository.webUrl, repository.branch, repository.commit, repository.problem, repository.problems, repository.installedOnly],
		[true, remote.url, null, 'main', remote.head(), '', [], []]
	);
	assert.deepEqual(repository.packages.map((pkg) => [pkg.name, pkg.matchCount, pkg.installed, pkg.updateAvailable, pkg.installedFrom]), [['goodbyes', 2, false, false, ''], ['support', 4, false, false, '']]);
	// A repository's id is the name of the folder its copy is kept in.
	assert.match(repository.id, /^[0-9a-f]{12}$/);
	assert.deepEqual([repository.id, copies()], [idOf(remote), [repository.id]]);
});

test('an address that is refused, or a repository that cannot be reached, changes nothing', async (t) => {
	const { service, call, remote, root, copies } = await setup(t);
	await fails(service.connectTeam('ext::sh -c "touch /tmp/owned"'), (error) => assert.equal(error.code, 'INVALID'));
	assert.deepEqual(service.settings().teamRepositories, []);
	await service.connectTeam(remote.url);
	await fails(service.connectTeam(join(root, 'nowhere.git')), (error) => assert.deepEqual([error.code, error.kind], ['GIT_FAILED', 'unreachable']));
	assert.deepEqual(service.settings().teamRepositories, [remote.url]);
	assert.equal(only((await call('GET', '/team')).body).packages.length, 2);
	// Nothing of the one that failed is left on disk.
	assert.deepEqual(copies(), [idOf(remote)]);
});

test('installing puts the package where Espanso reads it, and the app lists it as a team package', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	await service.connectTeam(remote.url);
	const reply = await call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	assert.equal(reply.status, 200);
	assert.deepEqual(named(only(reply.body).packages).goodbyes.installed, true);
	// Installing answers what the status route answers.
	assert.deepEqual(reply.body, (await call('GET', '/team')).body);
	assert.deepEqual(readdirSync(join(matchDir, 'team', 'goodbyes')).sort(), ['.snippet-editor.json', '_manifest.yml', 'package.yml']);
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':bye', 'Goodbye for now'], [':cheers', 'Cheers,']));
	const marker = JSON.parse(readFileSync(join(matchDir, 'team', 'goodbyes', '.snippet-editor.json'), 'utf8'));
	assert.deepEqual([marker.repository, marker.commit, marker.state], [remote.url, remote.head(), 'installed']);
	const state = (await call('GET', '/state')).body;
	assert.deepEqual(state.team.map((pkg) => [pkg.name, pkg.files.map((file) => file.id)]), [['goodbyes', ['team:goodbyes:package.yml']]]);
	assert.deepEqual(code(await call('PUT', '/team/packages/nothing/installed', { body: {} })), [404, 'NOT_FOUND']);
	assert.deepEqual(code(await call('PUT', '/team/packages/Bad_Name/installed', { body: {} })), [400, 'INVALID']);
});

test('a change in the repository shows as an update for that package only, and updating clears it', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	await service.connectTeam(remote.url);
	await call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	await call('PUT', '/team/packages/support/installed', { body: {} });
	remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Goodbye, and thank you']) });

	const stale = named(only((await call('GET', '/team')).body).packages);
	assert.deepEqual([stale.goodbyes.updateAvailable, stale.support.updateAvailable], [false, false]);
	const refreshed = await call('POST', '/team/refresh');
	assert.equal(refreshed.status, 200);
	assert.deepEqual([named(only(refreshed.body).packages).goodbyes.updateAvailable, named(only(refreshed.body).packages).support.updateAvailable], [true, false]);
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':bye', 'Goodbye for now'], [':cheers', 'Cheers,']));

	const updated = await call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	assert.equal(named(only(updated.body).packages).goodbyes.updateAvailable, false);
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':bye', 'Goodbye, and thank you']));
});

test('a package that runs commands is installed only when that is accepted', async (t) => {
	const remote = seeded();
	remote.commit({
		'packages/tools/_manifest.yml': MANIFEST('tools'),
		'packages/tools/package.yml': 'matches:\n  - trigger: ":ip"\n    replace: "{{ip}}"\n    vars:\n      - name: ip\n        type: shell\n        params:\n          cmd: "ipconfig getifaddr en0"\n',
	});
	const { service, call, matchDir } = await setup(t, { remote });
	await service.connectTeam(remote.url);
	assert.equal(named(only((await call('GET', '/team')).body).packages).tools.runsCommands, true);
	for (const body of [{}, { acceptCommands: 'yes' }, { acceptCommands: false }, undefined]) {
		const refused = await call('PUT', '/team/packages/tools/installed', { body });
		assert.deepEqual(code(refused), [400, 'INVALID']);
		assert.match(refused.body.error.message, /runs commands/);
	}
	assert.equal(existsSync(join(matchDir, 'team', 'tools')), false);
	assert.equal((await call('PUT', '/team/packages/tools/installed', { body: { acceptCommands: true } })).status, 200);
	assert.equal(existsSync(join(matchDir, 'team', 'tools', 'package.yml')), true);
});

test('removing deletes the installed copy, and works with no repository connected', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	await service.connectTeam(remote.url);
	await call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	await call('PUT', '/team/packages/support/installed', { body: {} });
	const removed = await call('DELETE', '/team/packages/goodbyes/installed');
	assert.deepEqual([removed.status, named(only(removed.body).packages).goodbyes.installed], [200, false]);
	assert.equal(existsSync(join(matchDir, 'team', 'goodbyes')), false);
	assert.deepEqual(code(await call('DELETE', '/team/packages/goodbyes/installed')), [404, 'NOT_FOUND']);

	await service.disconnectTeam(idOf(remote));
	assert.deepEqual(service.settings().teamRepositories, []);
	// What it left behind is listed with where it came from.
	assert.deepEqual((await call('GET', '/team')).body, { connected: false, repositories: [], installedOnly: [{ name: 'support', repository: remote.url }], problem: '' });
	assert.equal(existsSync(join(matchDir, 'team', 'support', 'replies.yml')), true);
	const last = await call('DELETE', '/team/packages/support/installed');
	assert.deepEqual([last.status, last.body], [200, { connected: false, repositories: [], installedOnly: [], problem: '' }]);
	assert.equal(existsSync(join(matchDir, 'team', 'support')), false);
});

test('a package the repository dropped stays installed and is listed apart', async (t) => {
	const { service, call, remote } = await setup(t);
	await service.connectTeam(remote.url);
	await call('PUT', '/team/packages/support/installed', { body: {} });
	remote.commit({ 'packages/support/_manifest.yml': null, 'packages/support/replies.yml': null, 'packages/support/escalations.yml': null });
	const { body } = await call('POST', '/team/refresh');
	// Under its own repository, which is still connected. Not among those whose repository is not.
	assert.deepEqual([only(body).packages.map((pkg) => pkg.name), only(body).installedOnly, body.installedOnly], [['goodbyes'], [{ name: 'support' }], []]);
});

test('a proposal sends one of your own files and answers 201 with the branch', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	await service.connectTeam(remote.url);
	const reply = await call('POST', '/team/proposals', { body: { fileId: 'local:dates.yml', package: 'goodbyes', summary: 'Share the date snippets' } });
	assert.equal(reply.status, 201);
	assert.match(reply.body.branch, /^snippet-editor\/goodbyes-\d{8}-\d{6}$/);
	assert.deepEqual([reply.body.created, reply.body.compareUrl], [false, null]);
	assert.equal(remote.show(reply.body.branch, 'packages/goodbyes/dates.yml') + '\n', readFileSync(join(matchDir, 'dates.yml'), 'utf8'));
	assert.deepEqual(remote.log(reply.body.branch)[0], 'Test Person <test@example.com>|Share the date snippets');
	assert.deepEqual(remote.head(), remote.head(`${reply.body.branch}~1`));
});

test('a proposal is checked before git is involved', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	await service.connectTeam(remote.url);
	await call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	writeFileSync(join(matchDir, 'empty.yml'), 'matches: []\n');
	const good = { fileId: 'local:dates.yml', package: 'goodbyes', summary: 'Share' };
	const refused = async (body, pattern) => {
		const reply = await call('POST', '/team/proposals', { body });
		assert.deepEqual(code(reply), [400, 'INVALID'], JSON.stringify(body));
		assert.match(reply.body.error.message, pattern, JSON.stringify(body));
	};
	await refused({ ...good, fileId: undefined }, /`fileId`/);
	await refused({ ...good, package: 7 }, /`package`/);
	await refused({ ...good, summary: undefined }, /`summary`/);
	await refused({ ...good, title: 5 }, /`title`/);
	await refused({ ...good, fileId: 'package:goodbyes:package.yml' }, /your own files/);
	await refused({ ...good, fileId: 'team:goodbyes:package.yml' }, /your own files/);
	await refused({ ...good, fileId: 'local:broken.yml' }, /YAML errors/);
	await refused({ ...good, fileId: 'local:empty.yml' }, /no snippets/);
	await refused({ ...good, package: 'Bad_Name' }, /package name/);
	await refused({ ...good, package: 'brand-new' }, /`title`/);
	assert.deepEqual(code(await call('POST', '/team/proposals', { body: { ...good, fileId: 'local:missing.yml' } })), [404, 'NOT_FOUND']);
	assert.deepEqual(remote.branches(), ['main']);
});

test('a failure of git answers 502 with the plain reason', async (t) => {
	const { service, call, remote } = await setup(t);
	await service.connectTeam(remote.url);
	remote.refuseProposals();
	const reply = await call('POST', '/team/proposals', { body: { fileId: 'local:dates.yml', package: 'goodbyes', summary: 'Share' } });
	assert.deepEqual([reply.status, reply.body], [502, { error: { code: 'GIT_FAILED', message: 'You do not have permission to push to this repository.' } }]);
});

// --- several repositories --------------------------------------------------------------

test('connecting another keeps the first, each with its own copy', async (t) => {
	const { service, call, remote, root, copies } = await setup(t);
	await service.connectTeam(remote.url);
	const other = another(OTHER);
	const answered = await service.connectTeam(other.url);

	assert.deepEqual(service.settings().teamRepositories, [remote.url, other.url]);
	assert.deepEqual(JSON.parse(readFileSync(join(root, 'data', 'settings.json'), 'utf8')).teamRepositories, [remote.url, other.url]);
	const { body } = await call('GET', '/team');
	assert.deepEqual(answered, body);
	// In the order they were connected.
	assert.deepEqual([body.connected, body.problem, body.installedOnly], [true, '', []]);
	assert.deepEqual(body.repositories.map((repository) => [repository.id, repository.repository, repository.commit, repository.packages.map((pkg) => pkg.name)]), [
		[idOf(remote), remote.url, remote.head(), ['goodbyes', 'support']],
		[idOf(other), other.url, other.head(), ['other']],
	]);
	assert.deepEqual(copies(), [idOf(remote), idOf(other)].sort());
	for (const copy of copies()) assert.deepEqual(readdirSync(join(root, 'data', 'team', copy)).sort(), ['fetched-at', 'repo.git']);
});

test('the service hands out each repository by its id, and the only one when no id is given', async (t) => {
	const { service, remote } = await setup(t);
	const other = another(OTHER);
	await service.connectTeam(remote.url);
	// One connected: callers that know of one repository still find it.
	assert.deepEqual([service.teams().length, service.team().address.url, service.team(idOf(remote)).address.url], [1, remote.url, remote.url]);
	assert.equal(service.team(), service.team(idOf(remote)));
	assert.equal(service.team(idOf(other)), null);

	await service.connectTeam(other.url);
	assert.deepEqual(service.teams().map((team) => team.address.url), [remote.url, other.url]);
	assert.deepEqual([service.team(idOf(remote)).address.url, service.team(idOf(other)).address.url], [remote.url, other.url]);
	// Two connected: which one is meant must be said.
	assert.equal(service.team(), null);
	for (const id of ['', 'nothing', remote.url, 42, {}, idOf(remote).toUpperCase()]) assert.equal(service.team(id), null, String(id));
	// The list handed out is a copy.
	service.teams().pop();
	assert.equal(service.teams().length, 2);
});

test('the state the window reads says whether any repository is connected', async (t) => {
	const { service, call, remote, root, copies } = await setup(t);
	const other = another(OTHER);
	assert.equal((await call('GET', '/state')).body.teamConnected, false);
	await service.connectTeam(remote.url);
	assert.equal((await call('GET', '/state')).body.teamConnected, true);
	const [copy] = copies();
	assert.ok(existsSync(join(root, 'data', 'team', copy, 'repo.git')));
	await service.connectTeam(other.url);
	assert.equal((await call('GET', '/state')).body.teamConnected, true);
	await service.disconnectTeam(idOf(remote));
	assert.equal((await call('GET', '/state')).body.teamConnected, true);
	await service.disconnectTeam(idOf(other));
	assert.equal((await call('GET', '/state')).body.teamConnected, false);
	assert.deepEqual(copies(), []);
});

test('the same address again copies nothing and answers the status as it is', async (t) => {
	const { service, remote, calls, copies } = await setup(t);
	const first = await service.connectTeam(remote.url);
	// Something new in the repository would show if connecting again fetched it.
	remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Changed since']) });
	calls.length = 0;
	const again = await service.connectTeam(`  ${remote.url}  `);
	assert.deepEqual(again, first);
	assert.deepEqual(calls.filter((args) => ['clone', 'fetch', 'ls-remote'].includes(args[0])), []);
	assert.deepEqual([service.settings().teamRepositories, copies()], [[remote.url], [idOf(remote)]]);
});

test('connecting twice at once copies the repository once', async (t) => {
	const { service, remote, root, calls, copies } = await setup(t);
	const [first, second] = await Promise.all([service.connectTeam(remote.url), service.connectTeam(remote.url)]);
	assert.deepEqual([first.connected, second.connected, first.repositories.length, second.repositories.length], [true, true, 1, 1]);
	assert.deepEqual(copies(), [idOf(remote)]);
	assert.deepEqual(readdirSync(join(root, 'data', 'team', idOf(remote))).sort(), ['fetched-at', 'repo.git']);
	assert.equal(calls.filter((args) => args[0] === 'clone').length, 1);
	assert.deepEqual(service.settings().teamRepositories, [remote.url]);
});

test('another form of a connected address is refused before git runs, and names the one connected', async (t) => {
	const { service, remote, calls, copies } = await setup(t);
	await service.connectTeam(remote.url);
	calls.length = 0;
	// The same folder, written with a slash at its end.
	await fails(service.connectTeam(`${remote.url}/`), (error) => assert.deepEqual([error.code, error.message], ['INVALID', `This repository is already connected, as ${remote.url}.`]));
	assert.deepEqual(calls, []);
	assert.deepEqual([service.settings().teamRepositories, copies()], [[remote.url], [idOf(remote)]]);
	assert.equal((await service.teamStatus()).repositories.length, 1);
});

test('the SSH address of a repository connected over HTTPS is refused, and the other way round', async (t) => {
	// The app as it runs: no folder is an address. Git alone is pointed at a
	// test repository when it is asked for the GitHub address.
	for (const [first, second, connectedAs] of [
		['https://github.com/acme/team-snippets', 'git@github.com:acme/team-snippets.git', 'https://github.com/acme/team-snippets.git'],
		['git@github.com:acme/team-snippets.git', 'acme/team-snippets', 'git@github.com:acme/team-snippets.git'],
		['acme/team-snippets', 'ssh://git@GitHub.com/Acme/Team-Snippets.git', 'https://github.com/acme/team-snippets.git'],
	]) {
		const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
		const remote = seeded();
		// Only the address that is connected has a test repository behind it.
		// The other form never should reach git, and here it cannot.
		const real = localGit(remote.root, new Map([[connectedAs, remote.url]]));
		const calls = [];
		const git = (args, options) => (calls.push(args), real(args, options));
		git.stopAll = () => real.stopAll();
		const service = await createService({ userDataDir: join(root, 'data'), env: { SNIPPET_EDITOR_MATCH_DIR: join(root, 'match') }, git });
		t.after(() => service.dispose());

		const status = await service.connectTeam(first);
		assert.deepEqual([only(status).repository, only(status).webUrl, only(status).packages.length], [connectedAs, 'https://github.com/acme/team-snippets', 2]);
		calls.length = 0;
		await fails(service.connectTeam(second), (error) => assert.deepEqual([error.code, error.message], ['INVALID', `This repository is already connected, as ${connectedAs}.`]));
		assert.deepEqual(calls, []);
		assert.deepEqual(service.settings().teamRepositories, [connectedAs]);
		assert.equal(readdirSync(join(root, 'data', 'team')).length, 1);
	}
});

test('ten repositories can be connected, and an eleventh is refused before git runs', async (t) => {
	const { service, calls, copies } = await setup(t, { remote: another() });
	const remotes = Array.from({ length: 11 }, () => another());
	for (const remote of remotes.slice(0, 10)) await service.connectTeam(remote.url);
	assert.deepEqual(service.settings().teamRepositories, remotes.slice(0, 10).map((remote) => remote.url));
	assert.equal((await service.teamStatus()).repositories.length, 10);

	calls.length = 0;
	await fails(service.connectTeam(remotes[10].url), (error) => assert.deepEqual([error.code, error.message], ['INVALID', 'Ten repositories are connected. Disconnect one first.']));
	assert.deepEqual(calls, []);
	assert.deepEqual([service.settings().teamRepositories.length, copies().length, copies().includes(idOf(remotes[10]))], [10, 10, false]);
	// One that is connected already is still answered, not refused.
	assert.equal((await service.connectTeam(remotes[3].url)).repositories.length, 10);

	// With one disconnected there is room again, and the new one goes last.
	await service.disconnectTeam(idOf(remotes[0]));
	await service.connectTeam(remotes[10].url);
	assert.deepEqual(service.settings().teamRepositories, remotes.slice(1).map((remote) => remote.url));
});

test('two different repositories connected at the same moment both end connected', async (t) => {
	const { service, remote, copies } = await setup(t);
	const other = another(OTHER);
	const [first, second] = await Promise.all([service.connectTeam(remote.url), service.connectTeam(other.url)]);
	// One at a time: the first answers before the second is there.
	assert.deepEqual([first.repositories.map((repository) => repository.repository), second.repositories.map((repository) => repository.repository)], [[remote.url], [remote.url, other.url]]);
	assert.deepEqual(service.settings().teamRepositories, [remote.url, other.url]);
	assert.deepEqual(copies(), [idOf(remote), idOf(other)].sort());
	assert.deepEqual((await service.teamStatus()).repositories.map((repository) => [repository.problem, repository.packages.length]), [['', 2], ['', 1]]);
});

test('two forms of one address connected at the same moment: one is connected, the other refused', async (t) => {
	const { service, remote, copies } = await setup(t);
	const results = await Promise.allSettled([service.connectTeam(`${remote.url}/`), service.connectTeam(remote.url)]);
	assert.deepEqual([results[0].status, results[1].status, results[1].reason?.code, results[1].reason?.message], ['fulfilled', 'rejected', 'INVALID', `This repository is already connected, as ${remote.url}/.`]);
	assert.deepEqual([service.settings().teamRepositories, copies().length], [[`${remote.url}/`], 1]);
});

test('a connect that fails leaves the list and the other repositories as they were', async (t) => {
	const { service, remote, root, copies } = await setup(t);
	const other = another(OTHER);
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);
	await (await service.team(idOf(other))).install('other');
	const before = await service.teamStatus();

	await fails(service.connectTeam(join(root, 'nowhere.git')), (error) => assert.deepEqual([error.code, error.kind], ['GIT_FAILED', 'unreachable']));
	await fails(service.connectTeam('ext::sh -c "touch /tmp/owned"'), (error) => assert.equal(error.code, 'INVALID'));
	await fails(service.connectTeam('https://someone:secret@github.com/acme/team'), (error) => assert.equal(error.code, 'INVALID'));

	assert.deepEqual(service.settings().teamRepositories, [remote.url, other.url]);
	assert.deepEqual(JSON.parse(readFileSync(join(root, 'data', 'settings.json'), 'utf8')).teamRepositories, [remote.url, other.url]);
	assert.deepEqual(copies(), [idOf(remote), idOf(other)].sort());
	assert.deepEqual(await service.teamStatus(), before);
	// The others still work.
	assert.equal(named(of(await service.refreshTeam(), other).packages).other.installed, true);
});

test('disconnecting one leaves the others, their copies and every installed package', async (t) => {
	const { service, call, remote, root, matchDir, copies } = await setup(t);
	const other = another(OTHER);
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);
	await service.team(idOf(remote)).install('goodbyes');
	await service.team(idOf(other)).install('other');

	const after = await service.disconnectTeam(idOf(remote));
	assert.deepEqual(after, (await call('GET', '/team')).body);
	assert.deepEqual([after.connected, after.problem, after.repositories.map((repository) => repository.repository)], [true, '', [other.url]]);
	assert.deepEqual(service.settings().teamRepositories, [other.url]);
	assert.deepEqual(JSON.parse(readFileSync(join(root, 'data', 'settings.json'), 'utf8')).teamRepositories, [other.url]);
	assert.deepEqual(copies(), [idOf(other)]);
	assert.deepEqual(readdirSync(join(root, 'data', 'team', idOf(other))).sort(), ['fetched-at', 'repo.git']);
	assert.deepEqual([service.team(idOf(remote)), service.team().address.url], [null, other.url]);

	// Both packages are still installed. The one whose repository went is listed apart, with its address.
	assert.deepEqual([existsSync(join(matchDir, 'team', 'goodbyes', 'package.yml')), existsSync(join(matchDir, 'team', 'other', 'package.yml'))], [true, true]);
	assert.deepEqual(after.installedOnly, [{ name: 'goodbyes', repository: remote.url }]);
	assert.deepEqual([named(only(after).packages).other.installed, only(after).installedOnly], [true, []]);
	// The one that stayed still fetches and installs.
	other.commit({ 'packages/other/package.yml': MATCHES([':o', 'Other, changed']) });
	assert.equal(named(only(await service.refreshTeam(idOf(other))).packages).other.updateAvailable, true);
});

test('disconnecting twice, or an id that is not connected, answers the list as it is', async (t) => {
	const { service, remote, calls, copies } = await setup(t);
	const other = another(OTHER);
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);
	const [first, second] = await Promise.all([service.disconnectTeam(idOf(remote)), service.disconnectTeam(idOf(remote))]);
	assert.deepEqual(first, second);
	assert.deepEqual(first.repositories.map((repository) => repository.repository), [other.url]);

	const before = await service.teamStatus();
	calls.length = 0;
	for (const id of [idOf(remote), 'nothing', '', 42, other.url]) assert.deepEqual(await service.disconnectTeam(id), before, String(id));
	assert.deepEqual([service.settings().teamRepositories, copies()], [[other.url], [idOf(other)]]);
	// Nothing was removed, and nothing was written.
	assert.deepEqual(calls.filter((args) => ['clone', 'fetch', 'ls-remote'].includes(args[0])), []);
});

test('disconnecting with no id changes nothing and says so, whether none, one or several are connected', async (t) => {
	const { service, remote, root, copies } = await setup(t);
	const other = another(OTHER);
	const notNamed = (error) => assert.deepEqual([error.code, error.message], ['INVALID', 'No repository was named, so nothing was disconnected.']);
	const saved = () => JSON.parse(readFileSync(join(root, 'data', 'settings.json'), 'utf8')).teamRepositories;
	const untouched = async (status, urls) => {
		for (const id of [undefined, null]) await fails(service.disconnectTeam(id), notNamed);
		await fails(service.disconnectTeam(), notNamed);
		assert.deepEqual([await service.teamStatus(), service.settings().teamRepositories, saved(), copies().length], [status, urls, urls, urls.length]);
	};

	// None connected: there is still nothing a missing id could mean.
	await fails(service.disconnectTeam(), notNamed);
	// One connected. "The only one" is what `team()` answers with no id. It is
	// never what a disconnect means: an id that went missing on its way here
	// must not take a repository with it.
	await service.connectTeam(remote.url);
	assert.equal(service.team(), service.teams()[0]);
	await untouched(await service.teamStatus(), [remote.url]);
	// Several connected.
	await service.connectTeam(other.url);
	await untouched(await service.teamStatus(), [remote.url, other.url]);

	// Named, each goes.
	assert.deepEqual((await service.disconnectTeam(idOf(remote))).repositories.map((repository) => repository.repository), [other.url]);
	assert.deepEqual(await service.disconnectTeam(idOf(other)), { connected: false, repositories: [], installedOnly: [], problem: '' });
	assert.deepEqual([service.settings().teamRepositories, copies()], [[], []]);
});

test('a disconnect asked for while that repository is fetching waits its turn, and the others keep working', async (t) => {
	const { service, remote, root, hold, copies } = await setup(t);
	const other = another(OTHER);
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);

	const release = hold((args, options) => args[0] === 'ls-remote' && options.cwd.includes(idOf(remote)));
	t.after(release);
	const fetching = service.refreshTeam(idOf(remote));
	let left = false;
	const leaving = service.disconnectTeam(idOf(remote)).then((status) => ((left = true), status));

	// The other repository fetches, installs and is listed while the first is held up.
	other.commit({ 'packages/other/package.yml': MATCHES([':o', 'Other, changed']) });
	const meanwhile = await soon(service.refreshTeam(idOf(other)), 'Checking the other repository');
	assert.equal(of(meanwhile, other).commit, other.head());
	await soon(service.team(idOf(other)).install('other'), 'Installing from the other repository');
	assert.equal(named(of(await soon(service.teamStatus(), 'The status'), other).packages).other.installed, true);
	// The first is still connected: its fetch has not ended.
	assert.deepEqual([left, service.settings().teamRepositories, existsSync(join(root, 'data', 'team', idOf(remote), 'repo.git'))], [false, [remote.url, other.url], true]);

	release();
	await fetching;
	const after = await leaving;
	assert.deepEqual([after.repositories.map((repository) => repository.repository), service.settings().teamRepositories, copies()], [[other.url], [other.url], [idOf(other)]]);
});

test('a check for updates that arrives while a repository is being disconnected does not copy it again', async (t) => {
	const { service, remote, hold, copies } = await setup(t);
	const other = another(OTHER);
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);

	const release = hold((args, options) => args[0] === 'ls-remote' && options.cwd.includes(idOf(remote)));
	t.after(release);
	const fetching = service.refreshTeam(idOf(remote));
	const leaving = service.disconnectTeam(idOf(remote));
	// Let the disconnect take its place behind the fetch, then ask for every
	// repository to be checked, and for the one that is leaving by itself.
	await new Promise((resolve) => setImmediate(resolve));
	const late = service.refreshTeam();
	const alone = service.refreshTeam(idOf(remote)).then(() => null, (error) => error);

	release();
	await Promise.all([fetching, leaving, late]);
	// Asked for by itself, it says why not.
	assert.deepEqual([(await alone)?.code, (await alone)?.message], ['NOT_CONNECTED', 'That repository is being disconnected.']);
	assert.deepEqual([copies(), service.settings().teamRepositories, (await service.teamStatus()).repositories.map((repository) => repository.repository)], [[idOf(other)], [other.url], [other.url]]);
});

test('when the settings cannot be saved, the list is as it was, and the repository can still be fetched and disconnected', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
	const { service, remote, root, copies } = await setup(t);
	const other = another(OTHER);
	await service.connectTeam(remote.url);
	const settingsFile = join(root, 'data', 'settings.json');
	chmodSync(settingsFile, 0o444);
	t.after(() => chmodSync(settingsFile, 0o644));

	// Connecting: the copy that was made goes again, and nothing is listed.
	await fails(service.connectTeam(other.url), (error) => assert.equal(error.code, 'EACCES'));
	assert.deepEqual([service.settings().teamRepositories, service.teams().map((team) => team.address.url), copies()], [[remote.url], [remote.url], [idOf(remote)]]);

	// Disconnecting: its copy has gone, but it is still in the saved list, so it is still connected.
	await fails(service.disconnectTeam(idOf(remote)), (error) => assert.equal(error.code, 'EACCES'));
	assert.deepEqual([service.settings().teamRepositories, service.teams().map((team) => team.address.url)], [[remote.url], [remote.url]]);
	assert.deepEqual([only(await service.teamStatus()).repository, only(await service.teamStatus()).branch], [remote.url, null]);
	// Checking for updates copies it again, as it does whenever the copy has gone.
	const again = await service.refreshTeam(idOf(remote));
	assert.deepEqual([only(again).commit, only(again).problem, copies()], [remote.head(), '', [idOf(remote)]]);

	chmodSync(settingsFile, 0o644);
	assert.deepEqual(await service.disconnectTeam(idOf(remote)), { connected: false, repositories: [], installedOnly: [], problem: '' });
	assert.deepEqual([service.settings().teamRepositories, copies()], [[], []]);
});

// --- checking for updates --------------------------------------------------------------

test('checking one repository fetches that one only, and an id that is not connected is 404', async (t) => {
	const { service, call, remote } = await setup(t);
	const other = another(OTHER);
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);
	const [mine, theirs] = [remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Newer']) }), other.commit({ 'packages/other/package.yml': MATCHES([':o', 'Newer']) })];

	const one = await service.refreshTeam(idOf(other));
	assert.deepEqual(one, (await call('GET', '/team')).body);
	assert.notEqual(of(one, remote).commit, mine);
	assert.equal(of(one, other).commit, theirs);

	const all = await service.refreshTeam();
	assert.deepEqual([of(all, remote).commit, of(all, other).commit], [mine, theirs]);

	for (const id of ['nothing', '', 42, remote.url]) {
		await fails(service.refreshTeam(id), (error) => assert.deepEqual([error.code, error.message], ['NOT_FOUND', 'That repository is not connected.']));
	}
});

test('checking all with one out of reach fetches the rest, and the failure is recorded on that one', async (t) => {
	const { service, remote } = await setup(t);
	const other = another(OTHER);
	const third = another({ third: MATCHES([':t', 'Third']) });
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);
	await service.connectTeam(third.url);
	const [mine, last] = [remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Newer']) }), third.commit({ 'packages/third/package.yml': MATCHES([':t', 'Newer']) })];
	const was = other.head();
	cpSync(other.url, `${other.url}.moved`, { recursive: true });
	rmSync(other.url, { recursive: true, force: true });

	const status = await service.refreshTeam();
	assert.deepEqual([status.connected, status.problem], [true, '']);
	assert.deepEqual([of(status, remote).commit, of(status, remote).problem], [mine, '']);
	assert.deepEqual([of(status, third).commit, of(status, third).problem], [last, '']);
	// What was fetched before is still there to browse.
	assert.match(of(status, other).problem, /^Git could not reach that repository\./);
	assert.deepEqual([of(status, other).commit, of(status, other).packages.map((pkg) => pkg.name)], [was, ['other']]);

	// Asked for by itself, the failure is also the answer.
	await fails(service.refreshTeam(idOf(other)), (error) => assert.deepEqual([error.code, error.kind], ['GIT_FAILED', 'unreachable']));
	assert.match(of(await service.teamStatus(), other).problem, /^Git could not reach that repository\./);

	// Once it answers again, the complaint goes away.
	cpSync(`${other.url}.moved`, other.url, { recursive: true });
	assert.deepEqual((await service.refreshTeam()).repositories.map((repository) => repository.problem), ['', '', '']);
});

test('"check for updates" copies the repository again if the copy has gone', async (t) => {
	const { service, call, remote, root } = await setup(t);
	await service.connectTeam(remote.url);
	rmSync(join(root, 'data', 'team'), { recursive: true, force: true });
	const refreshed = await call('POST', '/team/refresh');
	assert.deepEqual([refreshed.status, only(refreshed.body).commit, only(refreshed.body).packages.length], [200, remote.head(), 2]);
});

// --- the routes, where which repository is meant has to be said -----------------------------

// How a message names a repository: owner/repo, then its id in brackets. A
// test's repository is a folder, which has no owner, so its address stands in.
const listed = (remote) => `${remote.url} (${idOf(remote)})`;
const WHICH = 'Say which: set `repository` to one of the ids in brackets.';
const NOT_CONNECTED = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'That repository is not connected.' } } };
const NOT_TEXT = { status: 400, body: { error: { code: 'INVALID', message: '`repository` must be text.' } } };
const proposalsIn = (remote) => remote.branches().filter((branch) => branch.startsWith('snippet-editor/'));

test('checking for updates by route: every repository, or one by its id', async (t) => {
	const { service, call, remote } = await setup(t);
	const other = another(OTHER);
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);
	const [mine, theirs] = [remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Newer']) }), other.commit({ 'packages/other/package.yml': MATCHES([':o', 'Newer']) })];

	const one = await call('POST', `/team/repositories/${idOf(other)}/refresh`);
	assert.equal(one.status, 200);
	// It answers what the status route answers: every connected repository.
	assert.deepEqual(one.body, (await call('GET', '/team')).body);
	assert.notEqual(of(one.body, remote).commit, mine);
	assert.equal(of(one.body, other).commit, theirs);

	// Something new in each: checking all fetches both.
	const [mineAgain, theirsAgain] = [remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Newer again']) }), other.commit({ 'packages/other/package.yml': MATCHES([':o', 'Newer again']) })];
	const all = await call('POST', '/team/refresh');
	assert.deepEqual([all.status, of(all.body, remote).commit, of(all.body, other).commit], [200, mineAgain, theirsAgain]);
	assert.deepEqual(all.body, (await call('GET', '/team')).body);

	for (const id of ['nothing', idOf(other).toUpperCase(), encodeURIComponent(other.url), '0123456789ab']) assert.deepEqual(await call('POST', `/team/repositories/${id}/refresh`), NOT_CONNECTED, id);
	assert.deepEqual(code(await call('GET', `/team/repositories/${idOf(other)}/refresh`)), [405, 'METHOD_NOT_ALLOWED']);

	// One out of reach. Checked among all, that is recorded on it and the rest
	// are fetched. Checked by itself, the failure is the answer.
	const newer = remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Newer still']) });
	rmSync(other.url, { recursive: true, force: true });
	const partly = await call('POST', '/team/refresh');
	assert.equal(partly.status, 200);
	assert.match(of(partly.body, other).problem, /^Git could not reach that repository\./);
	assert.deepEqual([of(partly.body, remote).problem, of(partly.body, remote).commit, of(partly.body, other).commit], ['', newer, theirsAgain]);
	assert.deepEqual(code(await call('POST', `/team/repositories/${idOf(other)}/refresh`)), [502, 'GIT_FAILED']);
	assert.equal((await call('POST', `/team/repositories/${idOf(remote)}/refresh`)).status, 200);
});

test('with one connected, a request may name it or leave it out, and any other id is 404', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	await service.connectTeam(remote.url);
	const id = idOf(remote);
	const proposal = { fileId: 'local:dates.yml', package: 'goodbyes', summary: 'Share' };

	assert.equal((await call('PUT', '/team/packages/goodbyes/installed')).status, 200);
	const installed = await call('PUT', '/team/packages/support/installed', { body: { repository: id } });
	assert.deepEqual([installed.status, named(only(installed.body).packages).support.installed], [200, true]);
	assert.equal((await call('POST', '/team/proposals', { body: proposal })).status, 201);
	assert.equal((await call('POST', '/team/proposals', { body: { ...proposal, summary: 'Share again', package: 'support', repository: id } })).status, 201);
	assert.equal(proposalsIn(remote).length, 2);
	assert.equal((await call('POST', `/team/repositories/${id}/refresh`)).status, 200);

	for (const repository of ['nothing', '', id.toUpperCase(), remote.url]) {
		assert.deepEqual(await call('PUT', '/team/packages/goodbyes/installed', { body: { repository } }), NOT_CONNECTED, repository);
		assert.deepEqual(await call('POST', '/team/proposals', { body: { ...proposal, repository } }), NOT_CONNECTED, repository);
	}
	for (const repository of [7, null, true, [id], { id }]) {
		assert.deepEqual(await call('PUT', '/team/packages/goodbyes/installed', { body: { repository } }), NOT_TEXT, JSON.stringify(repository));
		assert.deepEqual(await call('POST', '/team/proposals', { body: { ...proposal, repository } }), NOT_TEXT, JSON.stringify(repository));
	}
	assert.equal(proposalsIn(remote).length, 2);
	// The one connected repository still answers for a name it does not have, and for one that is no name.
	assert.deepEqual(await call('PUT', '/team/packages/nothing/installed', { body: {} }), { status: 404, body: { error: { code: 'NOT_FOUND', message: `${remote.url} has no package named nothing.` } } });
	assert.deepEqual(code(await call('PUT', '/team/packages/Bad_Name/installed', { body: { repository: id } })), [400, 'INVALID']);
	assert.deepEqual(readdirSync(join(matchDir, 'team')).sort(), ['goodbyes', 'support']);
});

test('installing with no repository named uses the one connected repository that offers the name', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	const other = another(OTHER);
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);
	const from = (name) => JSON.parse(readFileSync(join(matchDir, 'team', name, '.snippet-editor.json'), 'utf8')).repository;

	const first = await call('PUT', '/team/packages/support/installed', { body: {} });
	assert.deepEqual([first.status, from('support'), named(of(first.body, remote).packages).support.installed], [200, remote.url, true]);
	assert.deepEqual(first.body, (await call('GET', '/team')).body);
	// With no body at all, too.
	const second = await call('PUT', '/team/packages/other/installed');
	assert.deepEqual([second.status, from('other'), named(of(second.body, other).packages).other.installed], [200, other.url, true]);

	// A name neither offers, and a name that is not one.
	assert.deepEqual(await call('PUT', '/team/packages/nothing/installed', { body: {} }), { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No connected repository has a package named nothing.' } } });
	const bad = await call('PUT', '/team/packages/Bad_Name/installed', { body: {} });
	assert.deepEqual([code(bad), bad.body.error.message], [[400, 'INVALID'], 'A package name is lowercase letters, digits and dashes, 80 characters or fewer.']);

	// Named, a repository is the only one asked: the second does not offer the first's package.
	assert.deepEqual(await call('PUT', '/team/packages/goodbyes/installed', { body: { repository: idOf(other) } }), { status: 404, body: { error: { code: 'NOT_FOUND', message: `${other.url} has no package named goodbyes.` } } });
	assert.equal(existsSync(join(matchDir, 'team', 'goodbyes')), false);
	assert.equal((await call('PUT', '/team/packages/goodbyes/installed', { body: { repository: idOf(remote) } })).status, 200);
	assert.equal(from('goodbyes'), remote.url);

	// Removing names no repository, with any number connected.
	const removed = await call('DELETE', '/team/packages/other/installed');
	assert.deepEqual([removed.status, named(of(removed.body, other).packages).other.installed, existsSync(join(matchDir, 'team', 'other'))], [200, false, false]);
});

test('a name that two repositories offer is installed only once the request says from which', async (t) => {
	const { service, call, remote, matchDir, calls } = await setup(t);
	const other = another({ goodbyes: MATCHES([':bye', 'The other goodbye']), other: MATCHES([':o', 'Other']) });
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);
	const path = '/team/packages/goodbyes/installed';

	calls.length = 0;
	const unsure = await call('PUT', path, { body: {} });
	assert.deepEqual(unsure, { status: 409, body: { error: { code: 'AMBIGUOUS', message: `Two repositories offer goodbyes: ${listed(remote)} and ${listed(other)}. ${WHICH}` } } });
	// Agreeing to commands does not say which, and neither does having no body.
	assert.deepEqual(code(await call('PUT', path, { body: { acceptCommands: true } })), [409, 'AMBIGUOUS']);
	assert.deepEqual(code(await call('PUT', path)), [409, 'AMBIGUOUS']);
	for (const repository of [7, null, true, [idOf(other)]]) assert.deepEqual(await call('PUT', path, { body: { repository } }), NOT_TEXT, JSON.stringify(repository));
	for (const repository of ['nothing', '', other.url]) assert.deepEqual(await call('PUT', path, { body: { repository } }), NOT_CONNECTED, repository);
	assert.equal(existsSync(join(matchDir, 'team', 'goodbyes')), false);
	// Nothing was fetched to find that out: what each offers is read from its copy.
	assert.deepEqual(calls.filter((args) => ['clone', 'fetch', 'ls-remote', 'push'].includes(args[0])), []);

	const chosen = await call('PUT', path, { body: { repository: idOf(other) } });
	assert.equal(chosen.status, 200);
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':bye', 'The other goodbye']));
	assert.deepEqual([shown(of(chosen.body, other), 'goodbyes'), shown(of(chosen.body, remote), 'goodbyes')], [[true, false, ''], [false, false, other.url]]);

	// The name is now the other's. The first is refused by the install rule, in its own words.
	assert.deepEqual(await call('PUT', path, { body: { repository: idOf(remote) } }), { status: 409, body: { error: { code: 'EXISTS', message: taken('goodbyes', other.url) } } });
	assert.equal((await call('PUT', path, { body: { repository: idOf(other) } })).status, 200);
	// A name only one of them offers needs no choosing.
	assert.equal((await call('PUT', '/team/packages/support/installed', { body: {} })).status, 200);

	// Free again, and a third that offers it is listed with the other two.
	assert.equal((await call('DELETE', path)).status, 200);
	const third = another({ goodbyes: MATCHES([':bye', 'A third goodbye']) });
	await service.connectTeam(third.url);
	assert.equal((await call('PUT', path, { body: {} })).body.error.message, `Three repositories offer goodbyes: ${listed(remote)}, ${listed(other)} and ${listed(third)}. ${WHICH}`);
	// Disconnected, the first is no longer one of them.
	await service.disconnectTeam(idOf(remote));
	assert.equal((await call('PUT', path, { body: {} })).body.error.message, `Two repositories offer goodbyes: ${listed(other)} and ${listed(third)}. ${WHICH}`);
});

test('a name that two repositories offer and one of them holds means the holder, when the request names none', async (t) => {
	const { service, call, remote, matchDir, calls } = await setup(t);
	const other = another({ goodbyes: MATCHES([':bye', 'The other goodbye']) });
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);
	const path = '/team/packages/goodbyes/installed';
	const marker = join(matchDir, 'team', 'goodbyes', '.snippet-editor.json');
	const installedText = () => readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8');
	const ambiguous = (...remotes) => ({
		status: 409,
		body: { error: { code: 'AMBIGUOUS', message: `${remotes.length === 2 ? 'Two' : 'Three'} repositories offer goodbyes: ${remotes.slice(0, -1).map(listed).join(', ')} and ${listed(remotes.at(-1))}. ${WHICH}` } },
	});

	// Free: which one has to be said.
	assert.deepEqual(await call('PUT', path, { body: {} }), ambiguous(remote, other));
	assert.equal((await call('PUT', path, { body: { repository: idOf(other) } })).status, 200);

	// Held by the second, which has something newer. An update that names no
	// repository can only be for the holder: the clash rule refuses the first.
	other.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'A newer goodbye']) });
	remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Newer in the first too']) });
	await service.refreshTeam();
	calls.length = 0;
	const updated = await call('PUT', path, { body: {} });
	assert.equal(updated.status, 200);
	assert.deepEqual(updated.body, (await call('GET', '/team')).body);
	assert.deepEqual([shown(of(updated.body, other), 'goodbyes'), shown(of(updated.body, remote), 'goodbyes')], [[true, false, ''], [false, false, other.url]]);
	assert.deepEqual([installedText(), JSON.parse(readFileSync(marker, 'utf8')).repository], [MATCHES([':bye', 'A newer goodbye']), other.url]);
	// Nothing was fetched to find the holder: it is read from the copies and the markers.
	assert.deepEqual(calls.filter((args) => ['clone', 'fetch', 'ls-remote', 'push'].includes(args[0])), []);
	// With no body at all, and with only the agreement to commands in it.
	assert.equal((await call('PUT', path)).status, 200);
	assert.equal((await call('PUT', path, { body: { acceptCommands: true } })).status, 200);
	// Named, the other is still refused in the install rule's own words.
	assert.deepEqual(await call('PUT', path, { body: { repository: idOf(remote) } }), { status: 409, body: { error: { code: 'EXISTS', message: taken('goodbyes', other.url) } } });

	// A third that offers the name changes nothing: one holds it.
	const third = another({ goodbyes: MATCHES([':bye', 'A third goodbye']) });
	await service.connectTeam(third.url);
	assert.equal((await call('PUT', path, { body: {} })).status, 200);
	assert.equal(installedText(), MATCHES([':bye', 'A newer goodbye']));

	// A marker that names no repository is nobody's. Every repository that
	// offers the name shows it as installed, so none of them is the holder.
	writeFileSync(marker, '{ not json');
	assert.deepEqual(await call('PUT', path, { body: {} }), ambiguous(remote, other, third));
	assert.equal((await call('PUT', path, { body: { repository: idOf(other) } })).status, 200);

	// The holder stops offering it. The name is still its own, so no other
	// could install it, and the request is not handed to one of them.
	other.commit({ 'packages/goodbyes/_manifest.yml': null, 'packages/goodbyes/package.yml': null });
	await service.refreshTeam(idOf(other));
	assert.deepEqual(await call('PUT', path, { body: {} }), ambiguous(remote, third));
	assert.equal(installedText(), MATCHES([':bye', 'A newer goodbye']));
	// The holder is disconnected: the same.
	await service.disconnectTeam(idOf(other));
	assert.deepEqual(await call('PUT', path, { body: {} }), ambiguous(remote, third));
	// Removed, the name is free, and still which one has to be said.
	assert.equal((await call('DELETE', path)).status, 200);
	assert.deepEqual(await call('PUT', path, { body: {} }), ambiguous(remote, third));
});

test('with several connected, a proposal says which repository it is for, and goes to that one only', async (t) => {
	const { service, call, remote, calls } = await setup(t);
	const other = another(OTHER);
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);
	const good = { fileId: 'local:dates.yml', package: 'goodbyes', summary: 'Share' };

	calls.length = 0;
	const unsure = await call('POST', '/team/proposals', { body: good });
	assert.deepEqual(unsure, { status: 409, body: { error: { code: 'AMBIGUOUS', message: `Two repositories are connected: ${listed(remote)} and ${listed(other)}. ${WHICH}` } } });
	// Which repository comes first: nothing else in the request is looked at until it is known.
	assert.deepEqual(code(await call('POST', '/team/proposals', { body: {} })), [409, 'AMBIGUOUS']);
	assert.deepEqual(code(await call('POST', '/team/proposals')), [409, 'AMBIGUOUS']);
	for (const repository of [7, null, true, [idOf(other)]]) assert.deepEqual(await call('POST', '/team/proposals', { body: { ...good, repository } }), NOT_TEXT, JSON.stringify(repository));
	for (const repository of ['nothing', '', other.url]) assert.deepEqual(await call('POST', '/team/proposals', { body: { ...good, repository } }), NOT_CONNECTED, repository);
	// All of that was refused before git ran.
	assert.deepEqual(calls, []);
	assert.deepEqual([proposalsIn(remote), proposalsIn(other)], [[], []]);

	// Each repository has its own names: goodbyes is a package of the first, and would be a new one in the second.
	const untitled = await call('POST', '/team/proposals', { body: { ...good, repository: idOf(other) } });
	assert.deepEqual(code(untitled), [400, 'INVALID']);
	assert.match(untitled.body.error.message, /`title`/);
	const created = await call('POST', '/team/proposals', { body: { ...good, repository: idOf(other), title: 'Goodbyes', description: 'Ways to say goodbye' } });
	assert.deepEqual([created.status, created.body.created], [201, true]);
	assert.deepEqual([proposalsIn(other), proposalsIn(remote)], [[created.body.branch], []]);
	assert.equal(other.show(created.body.branch, 'packages/goodbyes/_manifest.yml').includes('title: Goodbyes'), true);

	const added = await call('POST', '/team/proposals', { body: { ...good, repository: idOf(remote) } });
	assert.deepEqual([added.status, added.body.created], [201, false]);
	assert.deepEqual([proposalsIn(remote), proposalsIn(other)], [[added.body.branch], [created.body.branch]]);

	// What is checked of a proposal is still checked once the repository is known.
	const refused = await call('POST', '/team/proposals', { body: { ...good, repository: idOf(remote), fileId: 'team:goodbyes:package.yml' } });
	assert.deepEqual(code(refused), [400, 'INVALID']);
	assert.match(refused.body.error.message, /your own files/);
	assert.deepEqual(code(await call('POST', '/team/proposals', { body: { ...good, repository: idOf(remote), summary: undefined } })), [400, 'INVALID']);
});

// --- at start ---------------------------------------------------------------------------

test('the app reconnects every repository from its settings at the next start, and fetches each in the background', async (t) => {
	const context = await setup(t);
	const other = another(OTHER);
	await context.service.connectTeam(context.remote.url);
	await context.service.connectTeam(other.url);
	const newer = context.remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'See you']) });
	const newerToo = other.commit({ 'packages/other/package.yml': MATCHES([':o', 'Other, changed']) });

	const again = await context.start(join(context.root, 'data'));
	assert.deepEqual(again.service.teams().map((team) => team.address.url), [context.remote.url, other.url]);
	await again.service.teamFetched();
	const { body } = await again.call('GET', '/team');
	assert.deepEqual([body.connected, body.problem], [true, '']);
	assert.deepEqual(body.repositories.map((repository) => [repository.repository, repository.commit, repository.problem]), [[context.remote.url, newer, ''], [other.url, newerToo, '']]);
});

test('the window is told once for each repository fetched at start, and not at all with none', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const [first, second] = [seeded(), another(OTHER)];
	const git = localGit(first.root);
	let told = 0;
	const start = async (dataDir) => {
		const service = await createService({ userDataDir: dataDir, env: { SNIPPET_EDITOR_MATCH_DIR: join(root, 'match') }, git, allowLocalRepositories: true, onChange: () => (told += 1) });
		t.after(() => service.dispose());
		return service;
	};
	const none = await start(join(root, 'empty'));
	await none.teamFetched();
	assert.equal(told, 0);

	const service = await start(join(root, 'data'));
	await service.connectTeam(first.url);
	await service.connectTeam(second.url);
	told = 0;
	const again = await start(join(root, 'data'));
	await again.teamFetched();
	assert.equal(told, 2);
});

test('a start with the repository out of reach still opens, and says what went wrong', async (t) => {
	const context = await setup(t);
	await context.service.connectTeam(context.remote.url);
	await context.call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	cpSync(context.remote.url, `${context.remote.url}.moved`, { recursive: true });
	rmSync(context.remote.url, { recursive: true, force: true });

	const again = await context.start(join(context.root, 'data'));
	await again.service.teamFetched();
	const { body } = await again.call('GET', '/team');
	assert.equal(body.connected, true);
	assert.match(only(body).problem, /^Git could not reach that repository\./);
	// What was fetched before is still there to browse.
	assert.equal(named(only(body).packages).goodbyes.installed, true);
	assert.equal((await again.call('GET', '/state')).body.files.length, 4);
	// Checked by itself, the failure is the answer. Checked among all, it is recorded and the answer is the status.
	assert.deepEqual(code(await again.call('POST', `/team/repositories/${idOf(context.remote)}/refresh`)), [502, 'GIT_FAILED']);
	const still = await again.call('POST', '/team/refresh');
	assert.equal(still.status, 200);
	assert.match(only(still.body).problem, /^Git could not reach that repository\./);
	assert.equal(named(only(still.body).packages).goodbyes.installed, true);

	// Once it answers again, the complaint goes away.
	cpSync(`${context.remote.url}.moved`, context.remote.url, { recursive: true });
	const recovered = await again.call('POST', '/team/refresh');
	assert.deepEqual([recovered.status, only(recovered.body).problem], [200, '']);
});

test('at start, one repository out of reach does not hold up the others', async (t) => {
	const context = await setup(t);
	const other = another(OTHER);
	const third = another({ third: MATCHES([':t', 'Third']) });
	for (const remote of [context.remote, other, third]) await context.service.connectTeam(remote.url);
	await context.service.team(idOf(other)).install('other');
	const [newer, newest] = [context.remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'See you']) }), third.commit({ 'packages/third/package.yml': MATCHES([':t', 'Newer']) })];
	const was = other.head();
	rmSync(other.url, { recursive: true, force: true });

	const again = await context.start(join(context.root, 'data'));
	await again.service.teamFetched();
	const status = await again.service.teamStatus();
	assert.deepEqual([status.connected, status.problem, status.installedOnly], [true, '', []]);
	assert.deepEqual(status.repositories.map((repository) => repository.repository), [context.remote.url, other.url, third.url]);
	assert.deepEqual([of(status, context.remote).commit, of(status, context.remote).problem, of(status, third).commit, of(status, third).problem], [newer, '', newest, '']);
	// The one that could not be reached says so, and still lists what it had.
	assert.match(of(status, other).problem, /^Git could not reach that repository\./);
	assert.deepEqual([of(status, other).commit, named(of(status, other).packages).other.installed], [was, true]);
});

test('at start the repositories are fetched side by side: one that stalls keeps no other waiting', async (t) => {
	const context = await setup(t);
	const other = another(OTHER);
	await context.service.connectTeam(context.remote.url);
	await context.service.connectTeam(other.url);
	const before = of(await context.service.teamStatus(), other).fetchedAt;
	const [mine, theirs] = [context.remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'See you']) }), other.commit({ 'packages/other/package.yml': MATCHES([':o', 'Other, changed']) })];

	// The first in the saved list stalls: it is asked, and does not answer.
	const release = context.hold((args, options) => args[0] === 'ls-remote' && options.cwd.includes(idOf(context.remote)));
	t.after(release);
	const again = await context.start(join(context.root, 'data'));
	let ended = false;
	again.service.teamFetched().then(() => (ended = true));

	// The second answers. Looked at until its fetch has ended: its commit has
	// moved and the time of the fetch is written, which comes a moment later.
	// The limit is only there so that a failure ends. It can be long without
	// proving less: the first stays held until this test lets it go, so however
	// long the wait, the second can only have been fetched beside it.
	const fetched = (status) => of(status, other).commit === theirs && of(status, other).fetchedAt > before;
	let status = await again.service.teamStatus();
	for (const until = Date.now() + 30_000; !fetched(status) && Date.now() < until; status = await again.service.teamStatus()) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(of(status, other).commit, theirs, 'the second repository was not fetched while the first was waiting');
	assert.ok(of(status, other).fetchedAt > before, 'the second repository\'s fetch did not end while the first was waiting');
	// The first is still waiting, so the start's fetching as a whole has not ended.
	assert.deepEqual([of(status, context.remote).commit === mine, ended], [false, false]);

	release();
	await again.service.teamFetched();
	assert.deepEqual([of(await again.service.teamStatus(), context.remote).commit, ended], [mine, true]);
});

test('a settings file from before, with its one repository, connects it as before and is saved as a list at the next change', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const remote = seeded();
	writeFileSync(join(root, 'settings.json'), JSON.stringify({ maxBackups: 7, teamRepository: remote.url }));
	const context = await setup(t, { remote, userDataDir: root });
	await context.service.teamFetched();
	const status = await context.service.teamStatus();
	assert.deepEqual([status.connected, status.problem, only(status).repository, only(status).commit, only(status).packages.length], [true, '', remote.url, remote.head(), 2]);
	// Reading it changed nothing on disk.
	assert.deepEqual(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')), { maxBackups: 7, teamRepository: remote.url });

	const other = another(OTHER);
	await context.service.connectTeam(other.url);
	const saved = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
	assert.deepEqual([saved.teamRepositories, saved.maxBackups, 'teamRepository' in saved], [[remote.url, other.url], 7, false]);
});

test('as the app runs it, a folder on this computer is never a repository address', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const remote = seeded();
	writeFileSync(join(root, 'settings.json'), JSON.stringify({ teamRepository: remote.url }));
	// No options: this is how the app itself starts the service.
	const service = await createService({ userDataDir: root, env: { SNIPPET_EDITOR_MATCH_DIR: join(root, 'match') } });
	t.after(() => service.dispose());
	await service.teamFetched();
	assert.deepEqual(await service.teamStatus(), { connected: false, repositories: [], installedOnly: [], problem: REFUSED(1) });
	await fails(service.connectTeam(remote.url), (error) => assert.equal(error.code, 'INVALID'));
	await fails(service.connectTeam(`file://${remote.url}`), (error) => assert.equal(error.code, 'INVALID'));
	assert.equal(existsSync(join(root, 'team')), false);
});

test('a settings file with an address the app would refuse is not acted on', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	writeFileSync(join(root, 'settings.json'), JSON.stringify({ teamRepository: 'ext::sh -c "touch /tmp/owned"' }));
	const context = await setup(t, { userDataDir: root });
	await context.service.teamFetched();
	const { body } = await context.call('GET', '/team');
	assert.deepEqual(body, { connected: false, repositories: [], installedOnly: [], problem: REFUSED(1) });
	assert.deepEqual(context.calls, []);
});

test('a settings file with a refused address or the same repository twice loads the rest, and says which were skipped', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const [first, second] = [seeded(), another(OTHER)];
	const secret = 'https://someone:ghp_secret@github.com/acme/team';
	const saved = [first.url, 'ext::sh -c "touch /tmp/owned"', `${first.url}/`, second.url, secret, second.url, 'not an address'];
	writeFileSync(join(root, 'settings.json'), JSON.stringify({ teamRepositories: saved }));
	const context = await setup(t, { remote: first, userDataDir: root });
	await context.service.teamFetched();

	const status = await context.service.teamStatus();
	assert.equal(status.connected, true);
	assert.deepEqual(status.repositories.map((repository) => [repository.repository, repository.commit, repository.problem]), [[first.url, first.head(), ''], [second.url, second.head(), '']]);
	// The settings keep a repeat of the very same text out by themselves, so the last entry is the sixth.
	assert.equal(status.problem, [REFUSED(2), REPEATED(3, first.url), REFUSED(5), REFUSED(6)].join(' '));
	// An address is refused, among other reasons, for carrying a password. It is never repeated.
	assert.ok(!JSON.stringify(status).includes('ghp_secret'));
	assert.deepEqual(context.copies(root), [idOf(first), idOf(second)].sort());
	// Nothing is rewritten at start: the file is the person's to mend.
	assert.deepEqual(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).teamRepositories, saved);

	// The next change to the list saves only the ones that are connected, and the complaint goes.
	const third = another({ third: MATCHES([':t', 'Third']) });
	const after = await context.service.connectTeam(third.url);
	assert.deepEqual([after.problem, after.repositories.length], ['', 3]);
	assert.deepEqual(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).teamRepositories, [first.url, second.url, third.url]);
});

test('a complaint about the saved list stays until the list is saved again', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const first = seeded();
	writeFileSync(join(root, 'settings.json'), JSON.stringify({ teamRepositories: [first.url, 'not an address'] }));
	const context = await setup(t, { remote: first, userDataDir: root });
	await context.service.teamFetched();
	assert.equal((await context.service.refreshTeam()).problem, REFUSED(2));
	// Not connected, so nothing changes.
	assert.equal((await context.service.disconnectTeam('nothing')).problem, REFUSED(2));
	// Connected already, so nothing changes.
	assert.equal((await context.service.connectTeam(first.url)).problem, REFUSED(2));
	await fails(context.service.connectTeam(join(root, 'nowhere.git')), (error) => assert.equal(error.code, 'GIT_FAILED'));
	assert.equal((await context.service.teamStatus()).problem, REFUSED(2));
	const after = await context.service.disconnectTeam(idOf(first));
	assert.deepEqual(after, { connected: false, repositories: [], installedOnly: [], problem: '' });
	assert.deepEqual(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).teamRepositories, []);
});

// --- what is installed, across repositories -----------------------------------------------

test('two repositories that offer one name: the first to install holds it, and the other says where it is from', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	const other = another({ goodbyes: MATCHES([':bye', 'The other goodbye']), other: MATCHES([':o', 'Other']) });
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);
	await service.team(idOf(remote)).install('goodbyes');

	const { body } = await call('GET', '/team');
	const shown = (repository, name) => (({ installed, updateAvailable, installedFrom }) => [installed, updateAvailable, installedFrom])(named(repository.packages)[name]);
	assert.deepEqual([shown(of(body, remote), 'goodbyes'), shown(of(body, other), 'goodbyes'), shown(of(body, other), 'other')], [[true, false, ''], [false, false, remote.url], [false, false, '']]);
	assert.deepEqual([body.installedOnly, of(body, remote).installedOnly, of(body, other).installedOnly], [[], [], []]);

	await fails(service.team(idOf(other)).install('goodbyes'), (error) => assert.deepEqual([error.code, error.message], ['EXISTS', `A package named goodbyes is already installed from ${remote.url}. Remove it first, then install this one.`]));
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':bye', 'Goodbye for now'], [':cheers', 'Cheers,']));

	// Remove it first, then install the other.
	await service.removeTeamPackage('goodbyes');
	const after = await service.team(idOf(other)).install('goodbyes').then(() => service.teamStatus());
	assert.deepEqual([shown(of(after, remote), 'goodbyes'), shown(of(after, other), 'goodbyes')], [[false, false, other.url], [true, false, '']]);
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':bye', 'The other goodbye']));
});

test('a package from a repository that is not connected is listed apart with its address, is not handed to another, and can be removed', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	const other = another({ goodbyes: MATCHES([':bye', 'The other goodbye']) });
	await service.connectTeam(remote.url);
	await service.team().install('goodbyes');
	await service.team().install('support');
	await service.disconnectTeam(idOf(remote));
	// Another repository that offers one of the two names.
	const status = await service.connectTeam(other.url);

	assert.deepEqual(status.installedOnly, [{ name: 'goodbyes', repository: remote.url }, { name: 'support', repository: remote.url }]);
	const goodbyes = named(only(status).packages).goodbyes;
	assert.deepEqual([goodbyes.installed, goodbyes.updateAvailable, goodbyes.installedFrom, only(status).installedOnly], [false, false, remote.url, []]);
	await fails(service.team().install('goodbyes'), (error) => assert.equal(error.code, 'EXISTS'));

	const removed = await call('DELETE', '/team/packages/goodbyes/installed');
	assert.deepEqual([removed.status, removed.body.installedOnly, named(only(removed.body).packages).goodbyes.installedFrom], [200, [{ name: 'support', repository: remote.url }], '']);
	assert.equal(existsSync(join(matchDir, 'team', 'goodbyes')), false);
	assert.deepEqual((await service.removeTeamPackage('support')).installedOnly, []);
	assert.equal(existsSync(join(matchDir, 'team', 'support')), false);

	// Connected again, its packages are its own again.
	await service.team().install('goodbyes');
	await service.connectTeam(remote.url);
	const again = await service.teamStatus();
	assert.deepEqual([again.installedOnly, named(of(again, other).packages).goodbyes.installed, named(of(again, remote).packages).goodbyes.installedFrom], [[], true, other.url]);
});

// What a marker file says is text someone could have edited. These two tests
// rewrite the repository an installed package's marker names.
const remark = (matchDir, name, repository) => {
	const file = join(matchDir, 'team', name, '.snippet-editor.json');
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), repository }));
};

test('the repository a marker names reaches the status as an address, never as the text in the file', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	const other = another({ goodbyes: MATCHES([':bye', 'The other goodbye']) });
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);
	await service.team(idOf(remote)).install('goodbyes');
	await service.team(idOf(remote)).install('support');
	// Spaces around an address do not stop it being one, and a file can hold any number of them.
	for (const name of ['goodbyes', 'support']) remark(matchDir, name, `${' '.repeat(3_000_000)}${remote.url}  `);

	// Each package is still its own repository's, and the other is told where the name is held, in so many words.
	const both = await call('GET', '/team');
	assert.deepEqual([shown(of(both.body, remote), 'goodbyes'), shown(of(both.body, other), 'goodbyes')], [[true, false, ''], [false, false, remote.url]]);
	assert.ok(JSON.stringify(both.body).length < 20_000, `the status is ${JSON.stringify(both.body).length} characters long`);
	await fails(service.team(idOf(other)).install('goodbyes'), (error) => assert.deepEqual([error.code, error.message], ['EXISTS', taken('goodbyes', remote.url)]));

	// Listed apart once its repository is disconnected, by the same address.
	await service.disconnectTeam(idOf(remote));
	const left = await call('GET', '/team');
	assert.deepEqual(left.body.installedOnly, [{ name: 'goodbyes', repository: remote.url }, { name: 'support', repository: remote.url }]);
	assert.equal(named(only(left.body).packages).goodbyes.installedFrom, remote.url);
	assert.deepEqual(await service.teamStatus(), left.body);
	assert.ok(JSON.stringify(left.body).length < 20_000, `the status is ${JSON.stringify(left.body).length} characters long`);
});

test('a marker whose text holds a sign-in names no repository, and none of that text is shown anywhere', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	await service.connectTeam(remote.url);
	await service.team().install('goodbyes');
	await service.team().install('support');
	for (const name of ['goodbyes', 'support']) remark(matchDir, name, 'https://bob:s3cret@github.com/acme/team');
	// Everything the app says about team packages, to the window, the API and the tools.
	const said = async () => JSON.stringify([await service.teamStatus(), (await call('GET', '/team')).body, (await call('GET', '/state')).body]);
	const clean = (text) => assert.ok(!/s3cret|bob/.test(text), 'the marker\'s text is in what the app says');

	// Offered by a connected repository: each shows as needing an update, which repairs it.
	const offered = await service.teamStatus();
	assert.deepEqual([shown(only(offered), 'goodbyes'), shown(only(offered), 'support'), offered.installedOnly], [[true, true, ''], [true, true, ''], []]);
	clean(await said());

	// One dropped by its repository, then both with no repository connected: listed apart, with no address.
	remote.commit({ 'packages/support/_manifest.yml': null, 'packages/support/replies.yml': null, 'packages/support/escalations.yml': null });
	assert.deepEqual((await service.refreshTeam()).installedOnly, [{ name: 'support', repository: '' }]);
	clean(await said());
	await service.disconnectTeam(idOf(remote));
	assert.deepEqual((await service.teamStatus()).installedOnly, [{ name: 'goodbyes', repository: '' }, { name: 'support', repository: '' }]);
	clean(await said());

	// Another repository that offers the name may repair it, and says nothing of the old text either.
	const other = another({ goodbyes: MATCHES([':bye', 'The other goodbye']) });
	const again = await service.connectTeam(other.url);
	assert.deepEqual([shown(only(again), 'goodbyes'), again.installedOnly], [[true, true, ''], [{ name: 'support', repository: '' }]]);
	clean(await said());
	assert.deepEqual(shown(await service.team().install('goodbyes'), 'goodbyes'), [true, false, '']);
});

test('a damaged marker is listed apart only when no connected repository offers its name', async (t) => {
	const { service, remote, matchDir } = await setup(t);
	await service.connectTeam(remote.url);
	await service.team().install('goodbyes');
	const damage = (name) => {
		mkdirSync(join(matchDir, 'team', name), { recursive: true });
		writeFileSync(join(matchDir, 'team', name, '.snippet-editor.json'), '{ not json');
	};
	damage('goodbyes');
	damage('stray');

	const status = await service.teamStatus();
	// Offered by the repository: it shows there, as needing an update.
	assert.deepEqual([named(only(status).packages).goodbyes.installed, named(only(status).packages).goodbyes.updateAvailable], [true, true]);
	// Offered by nobody: it names no repository, and is listed so that it can be removed.
	assert.deepEqual([status.installedOnly, only(status).installedOnly], [[{ name: 'stray', repository: '' }], []]);

	await service.disconnectTeam(idOf(remote));
	assert.deepEqual((await service.teamStatus()).installedOnly, [{ name: 'goodbyes', repository: '' }, { name: 'stray', repository: '' }]);
	assert.deepEqual((await service.removeTeamPackage('stray')).installedOnly, [{ name: 'goodbyes', repository: '' }]);
});

test('after the match folder changes, team packages are installed in the new folder', async (t) => {
	const { service, call, remote, root } = await setup(t);
	await service.connectTeam(remote.url);
	const other = join(root, 'other-match');
	mkdirSync(other);
	await service.setMatchDir(other);
	const reply = await call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	assert.equal(named(only(reply.body).packages).goodbyes.installed, true);
	assert.equal(existsSync(join(other, 'team', 'goodbyes', 'package.yml')), true);
	assert.equal(existsSync(join(root, 'match', 'team')), false);
	assert.deepEqual((await call('GET', '/state')).body.team.map((pkg) => pkg.name), ['goodbyes']);
});

test('with two connected, a change of match folder is followed by both', async (t) => {
	const { service, call, remote, root, matchDir, copies } = await setup(t);
	const other = another(OTHER);
	await service.connectTeam(remote.url);
	await service.connectTeam(other.url);
	await service.team(idOf(remote)).install('goodbyes');
	const elsewhere = join(root, 'other-match');
	mkdirSync(elsewhere);
	await service.setMatchDir(elsewhere);

	// Both are still connected, with the copies they had.
	assert.deepEqual([service.settings().teamRepositories, service.teams().map((team) => team.address.url), copies()], [[remote.url, other.url], [remote.url, other.url], [idOf(remote), idOf(other)].sort()]);
	// The new folder has nothing installed, for either.
	const before = await service.teamStatus();
	assert.deepEqual([named(of(before, remote).packages).goodbyes.installed, named(of(before, other).packages).other.installed, before.installedOnly], [false, false, []]);

	await service.team(idOf(remote)).install('support');
	await service.team(idOf(other)).install('other');
	assert.deepEqual([existsSync(join(elsewhere, 'team', 'support', 'replies.yml')), existsSync(join(elsewhere, 'team', 'other', 'package.yml'))], [true, true]);
	// The old folder keeps what it had, and gains nothing.
	assert.deepEqual(readdirSync(join(matchDir, 'team')), ['goodbyes']);
	const after = await service.teamStatus();
	assert.deepEqual([named(of(after, remote).packages).support.installed, named(of(after, other).packages).other.installed], [true, true]);
	assert.deepEqual((await call('GET', '/state')).body.team.map((pkg) => pkg.name), ['other', 'support']);
});

// --- when git or the copy fails -----------------------------------------------------------

test('when git stops working, the status still answers, and the repository can still be disconnected', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const remote = seeded();
	const real = localGit(remote.root);
	let broken = false;
	const git = (args, options) => (broken ? Promise.reject(Object.assign(new Error('Git is not installed on this computer.'), { code: 'GIT_FAILED', kind: 'missing' })) : real(args, options));
	git.stopAll = () => {};
	const service = await createService({ userDataDir: join(root, 'data'), env: { SNIPPET_EDITOR_MATCH_DIR: join(root, 'match') }, git, allowLocalRepositories: true });
	t.after(() => service.dispose());
	const handle = createRouter({ service, log: () => {} });
	await service.connectTeam(remote.url);

	broken = true;
	const reply = await handle({ method: 'GET', path: '/api/v1/team' });
	assert.deepEqual([reply.status, reply.body.connected, only(reply.body).repository, only(reply.body).problem, only(reply.body).packages], [200, true, remote.url, 'Git is not installed on this computer.', []]);
	assert.deepEqual(code(await handle({ method: 'POST', path: `/api/v1/team/repositories/${idOf(remote)}/refresh` })), [502, 'GIT_FAILED']);
	const all = await handle({ method: 'POST', path: '/api/v1/team/refresh' });
	assert.deepEqual([all.status, only(all.body).problem], [200, 'Git is not installed on this computer.']);
	const after = await service.disconnectTeam(idOf(remote));
	assert.deepEqual([after.connected, service.settings().teamRepositories], [false, []]);
});

test('a repository that connects but cannot be listed is still connected, says why, and can be left', async (t) => {
	const remote = seeded();
	const real = localGit(remote.root);
	const git = (args, options) => (args.includes('ls-tree') ? Promise.reject(Object.assign(new Error('Git sent more than the app can read.'), { code: 'GIT_FAILED', kind: 'too-large' })) : real(args, options));
	git.stopAll = () => {};
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const service = await createService({ userDataDir: join(root, 'data'), env: { SNIPPET_EDITOR_MATCH_DIR: join(root, 'match') }, git, allowLocalRepositories: true });
	t.after(() => service.dispose());
	const status = await service.connectTeam(remote.url);
	assert.deepEqual([status.connected, status.problem, only(status).problem, only(status).packages], [true, '', 'Git sent more than the app can read.', []]);
	assert.equal((await service.disconnectTeam(idOf(remote))).connected, false);
});

test('an install that was cut short shows as needing an update, even though nothing changed in the repository', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	await service.connectTeam(remote.url);
	await call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	const markerFile = join(matchDir, 'team', 'goodbyes', '.snippet-editor.json');
	const marker = JSON.parse(readFileSync(markerFile, 'utf8'));
	writeFileSync(markerFile, JSON.stringify({ ...marker, state: 'installing' }));
	assert.deepEqual(named(only((await call('GET', '/team')).body).packages).goodbyes.updateAvailable, true);
	const repaired = await call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	assert.equal(named(only(repaired.body).packages).goodbyes.updateAvailable, false);
});

test('a package the app did not read cannot be installed, because it was not checked for commands', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const remote = seeded();
	const team = createTeam({
		dataDir: join(root, 'data'),
		address: parseRepositoryAddress(remote.url, { allowLocal: true }),
		git: localGit(remote.root),
		installed: () => createTeamPackages({ matchDir: join(root, 'match') }),
		// Room to read the first package, manifest and all, but not the second.
		limits: { totalBytes: 260 },
	});
	await team.connect();
	const status = await team.status();
	assert.deepEqual(status.packages.map((pkg) => [pkg.name, pkg.matchCount]), [['goodbyes', 2], ['support', null]]);
	await fails(team.install('support'), (error) => {
		assert.equal(error.code, 'INVALID');
		assert.match(error.message, /was not read/);
	});
	assert.equal(existsSync(join(root, 'match', 'team', 'support')), false);
});

test('closing the app stops any git call still under way', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	let stopped = 0;
	const git = localGit(root);
	const watching = (args, options) => git(args, options);
	watching.stopAll = () => (stopped += 1);
	const service = await createService({ userDataDir: join(root, 'data'), env: { SNIPPET_EDITOR_MATCH_DIR: join(root, 'match') }, git: watching });
	service.dispose();
	assert.equal(stopped, 1);
});

// --- a package belongs to the repository it was installed from ------------------------

// Two repositories that offer the same two packages, as the service holds
// them: each its own `team`, both installing into one match folder.
function twoTeams({ first = seeded(), second = seeded() } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teams-'));
	const matchDir = join(root, 'match');
	const packages = createTeamPackages({ matchDir, allowLocal: true });
	const real = localGit(first.root);
	// Every git call, so a test can show that none was made.
	const calls = [];
	const git = (args, options) => (calls.push(args), real(args, options));
	const teamFor = (remote) => createTeam({ dataDir: join(root, 'data'), address: parseRepositoryAddress(remote.url, { allowLocal: true }), git, installed: () => packages });
	const markerFile = (name) => join(matchDir, 'team', name, '.snippet-editor.json');
	return { root, matchDir, packages, calls, markerFile, remotes: { first, second }, first: teamFor(first), second: teamFor(second), readMarker: (name) => JSON.parse(readFileSync(markerFile(name), 'utf8')) };
}

const shown = (status, name) => (({ installed, updateAvailable, installedFrom }) => [installed, updateAvailable, installedFrom])(named(status.packages)[name]);
const taken = (name, from) => `A package named ${name} is already installed from ${from}. Remove it first, then install this one.`;

test('a package shows as installed only for the repository it came from; the other says where it is from', async () => {
	const { first, second, remotes } = twoTeams();
	await first.connect();
	await second.connect();
	assert.deepEqual([shown(await first.status(), 'goodbyes'), shown(await second.status(), 'goodbyes')], [[false, false, ''], [false, false, '']]);

	await first.install('goodbyes');
	assert.deepEqual(shown(await first.status(), 'goodbyes'), [true, false, '']);
	// The two repositories hold the very same package, and still it is not the second's.
	assert.deepEqual(shown(await second.status(), 'goodbyes'), [false, false, remotes.first.url]);
	assert.deepEqual([shown(await first.status(), 'support'), shown(await second.status(), 'support')], [[false, false, ''], [false, false, '']]);
});

test('a newer package of the same name in another repository is not an update for this one', async () => {
	const { first, second, remotes, matchDir } = twoTeams();
	await first.connect();
	await second.connect();
	await first.install('goodbyes');
	remotes.second.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'A newer goodbye, from the other team']) });
	assert.deepEqual(shown(await second.refresh(), 'goodbyes'), [false, false, remotes.first.url]);
	assert.deepEqual(shown(await first.refresh(), 'goodbyes'), [true, false, '']);
	// Its own repository's change is its update.
	remotes.first.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Goodbye, and thank you']) });
	assert.deepEqual(shown(await first.refresh(), 'goodbyes'), [true, true, '']);
	assert.deepEqual(shown(await first.install('goodbyes'), 'goodbyes'), [true, false, '']);
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':bye', 'Goodbye, and thank you']));
});

test('installing a name another repository holds is refused before any file is read', async () => {
	const { first, second, remotes, matchDir, calls, readMarker } = twoTeams();
	await first.connect();
	await second.connect();
	await first.install('goodbyes');
	const before = readdirSync(join(matchDir, 'team', 'goodbyes')).sort().map((entry) => [entry, readFileSync(join(matchDir, 'team', 'goodbyes', entry), 'utf8')]);

	calls.length = 0;
	await fails(second.install('goodbyes'), (error) => assert.deepEqual([error.code, error.message], ['EXISTS', taken('goodbyes', remotes.first.url)]));
	// Not even the listing was asked for.
	assert.deepEqual(calls, []);
	assert.deepEqual(readdirSync(join(matchDir, 'team', 'goodbyes')).sort().map((entry) => [entry, readFileSync(join(matchDir, 'team', 'goodbyes', entry), 'utf8')]), before);
	assert.equal(readMarker('goodbyes').repository, remotes.first.url);

	// Accepting commands does not get round it, and a free name still installs.
	await fails(second.install('goodbyes', { acceptCommands: true }), (error) => assert.equal(error.code, 'EXISTS'));
	assert.deepEqual(shown(await second.install('support'), 'support'), [true, false, '']);
	assert.equal(readMarker('support').repository, remotes.second.url);

	// Removed, the name is the second's to take.
	await (await import('node:fs/promises')).rm(join(matchDir, 'team', 'goodbyes'), { recursive: true });
	assert.deepEqual(shown(await second.install('goodbyes'), 'goodbyes'), [true, false, '']);
	assert.deepEqual(shown(await first.status(), 'goodbyes'), [false, false, remotes.second.url]);
});

test('each repository lists as left behind only the packages that were its own', async () => {
	const { first, second, remotes } = twoTeams();
	await first.connect();
	await second.connect();
	await first.install('goodbyes');
	await second.install('support');
	const gone = (name, extra = name === 'support' ? { 'packages/support/escalations.yml': null } : {}) => ({ [`packages/${name}/_manifest.yml`]: null, [`packages/${name}/${name === 'support' ? 'replies' : 'package'}.yml`]: null, ...extra });

	// The first repository drops both. Only goodbyes was its own.
	remotes.first.commit({ ...gone('goodbyes'), ...gone('support'), 'packages/other/_manifest.yml': MANIFEST('other'), 'packages/other/package.yml': MATCHES([':o', 'Other']) });
	const mine = await first.refresh();
	assert.deepEqual([mine.packages.map((pkg) => pkg.name), mine.installedOnly], [['other'], [{ name: 'goodbyes' }]]);
	// The second still offers both, so it has nothing left behind: goodbyes is not its own.
	assert.deepEqual((await second.status()).installedOnly, []);

	remotes.second.commit(gone('support'));
	const theirs = await second.refresh();
	assert.deepEqual([theirs.packages.map((pkg) => pkg.name), theirs.installedOnly], [['goodbyes'], [{ name: 'support' }]]);
	assert.deepEqual(shown(theirs, 'goodbyes'), [false, false, remotes.first.url]);
});

test('a marker that names no repository shows as needing an update wherever the name is offered, and either repository repairs it', async () => {
	for (const damage of [() => '{ not json', (marker) => JSON.stringify({ ...marker, repository: '' }), (marker) => JSON.stringify({ ...marker, repository: 'somewhere on the internet' })]) {
		const { first, second, remotes, markerFile, readMarker } = twoTeams();
		await first.connect();
		await second.connect();
		await first.install('goodbyes');
		writeFileSync(markerFile('goodbyes'), damage(readMarker('goodbyes')));

		assert.deepEqual([shown(await first.status(), 'goodbyes'), shown(await second.status(), 'goodbyes')], [[true, true, ''], [true, true, '']]);
		// It is neither repository's to list as left behind.
		assert.deepEqual([(await first.status()).installedOnly, (await second.status()).installedOnly], [[], []]);

		assert.deepEqual(shown(await second.install('goodbyes'), 'goodbyes'), [true, false, '']);
		assert.deepEqual([readMarker('goodbyes').repository, readMarker('goodbyes').state], [remotes.second.url, 'installed']);
		assert.deepEqual(shown(await first.status(), 'goodbyes'), [false, false, remotes.second.url]);
	}
});

test('two repositories installing one name at the same moment: one is installed and the other refused', async () => {
	const { first, second, remotes, matchDir, readMarker } = twoTeams();
	await first.connect();
	await second.connect();
	remotes.second.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'From the second']), 'packages/goodbyes/second.yml': MATCHES([':s', 'second']) });
	await second.refresh();

	const results = await Promise.allSettled([first.install('goodbyes'), second.install('goodbyes')]);
	assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
	const winner = results[0].status === 'fulfilled' ? 'first' : 'second';
	const refused = results.find((result) => result.status === 'rejected').reason;
	assert.deepEqual([refused.code, refused.message], ['EXISTS', taken('goodbyes', remotes[winner].url)]);

	// The folder is the winner's, whole, with nothing of the other's in it.
	const marker = readMarker('goodbyes');
	assert.deepEqual([marker.repository, marker.state], [remotes[winner].url, 'installed']);
	assert.deepEqual(readdirSync(join(matchDir, 'team', 'goodbyes')).sort(), winner === 'first' ? ['.snippet-editor.json', '_manifest.yml', 'package.yml'] : ['.snippet-editor.json', '_manifest.yml', 'package.yml', 'second.yml']);
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), winner === 'first' ? MATCHES([':bye', 'Goodbye for now'], [':cheers', 'Cheers,']) : MATCHES([':bye', 'From the second']));
	const [mine, theirs] = winner === 'first' ? [first, second] : [second, first];
	assert.deepEqual([shown(await mine.status(), 'goodbyes'), shown(await theirs.status(), 'goodbyes')], [[true, false, ''], [false, false, remotes[winner].url]]);
});

test('a package installed under the SSH address is still its own when the repository is connected over HTTPS', async () => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teams-'));
	const remote = seeded();
	const address = parseRepositoryAddress('https://github.com/acme/team-snippets');
	// The app as it runs, with no folders allowed as addresses. Git alone is
	// pointed at the test repository when it is asked for the GitHub address.
	const git = localGit(remote.root, new Map([[address.url, remote.url]]));
	const packages = createTeamPackages({ matchDir: join(root, 'match') });
	const team = createTeam({ dataDir: join(root, 'data'), address, git, installed: () => packages });
	const markerFile = join(root, 'match', 'team', 'goodbyes', '.snippet-editor.json');
	const marker = () => JSON.parse(readFileSync(markerFile, 'utf8'));
	await team.connect();

	assert.deepEqual(shown(await team.install('goodbyes'), 'goodbyes'), [true, false, '']);
	assert.equal(marker().repository, 'https://github.com/acme/team-snippets.git');

	for (const repository of ['git@github.com:acme/team-snippets.git', 'ssh://git@github.com/acme/team-snippets.git', 'git@GitHub.com:Acme/Team-Snippets.git']) {
		writeFileSync(markerFile, JSON.stringify({ ...marker(), repository }));
		assert.deepEqual(shown(await team.status(), 'goodbyes'), [true, false, ''], repository);
	}
	// Its update is still offered, and installing it is not refused.
	remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Goodbye, and thank you']) });
	assert.deepEqual(shown(await team.refresh(), 'goodbyes'), [true, true, '']);
	assert.deepEqual(shown(await team.install('goodbyes'), 'goodbyes'), [true, false, '']);
	assert.equal(marker().repository, 'https://github.com/acme/team-snippets.git');

	// Left behind, it is listed under this repository whichever form its marker has.
	writeFileSync(markerFile, JSON.stringify({ ...marker(), repository: 'git@github.com:acme/team-snippets.git' }));
	remote.commit({ 'packages/goodbyes/_manifest.yml': null, 'packages/goodbyes/package.yml': null });
	assert.deepEqual((await team.refresh()).installedOnly, [{ name: 'goodbyes' }]);

	// The same name under another owner is someone else's.
	writeFileSync(markerFile, JSON.stringify({ ...marker(), repository: 'git@github.com:other/team-snippets.git' }));
	assert.deepEqual((await team.status()).installedOnly, []);
	remote.commit({ 'packages/goodbyes/_manifest.yml': MANIFEST('goodbyes'), 'packages/goodbyes/package.yml': MATCHES([':bye', 'Back again']) });
	assert.deepEqual(shown(await team.refresh(), 'goodbyes'), [false, false, 'git@github.com:other/team-snippets.git']);
	await fails(team.install('goodbyes'), (error) => assert.deepEqual([error.code, error.message], ['EXISTS', taken('goodbyes', 'other/team-snippets')]));
});
