import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../core/apiRouter.js';
import { createGit } from '../core/git.js';
import { createService } from '../core/service.js';
import { createTeam } from '../core/team.js';
import { parseRepositoryAddress } from '../core/teamAddress.js';
import { createTeamPackages } from '../core/teamPackages.js';
import { MANIFEST, MATCHES, createRemote, gitEnv, seeded } from './helpers/teamRemote.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/match', import.meta.url));

async function setup(t, { remote = seeded(), userDataDir } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const matchDir = join(root, 'match');
	cpSync(FIXTURES, matchDir, { recursive: true });
	const start = async (dataDir = userDataDir ?? join(root, 'data')) => {
		const service = await createService({
			userDataDir: dataDir,
			env: { SNIPPET_EDITOR_MATCH_DIR: matchDir },
			git: createGit({ allowLocal: true, env: gitEnv(remote.root) }),
			allowLocalRepositories: true,
		});
		t.after(() => service.dispose());
		const handle = createRouter({ service, log: () => {} });
		return { service, call: (method, path, extra = {}) => handle({ method, path: `/api/v1${path}`, ...extra }) };
	};
	return { root, matchDir, remote, start, ...(await start()) };
}

const code = (reply) => [reply.status, reply.body?.error?.code];
const named = (packages) => Object.fromEntries(packages.map((pkg) => [pkg.name, pkg]));
const fails = async (promise, check) => {
	let caught;
	await promise.catch((error) => (caught = error));
	assert.ok(caught, 'expected a failure');
	check(caught);
};

test('with no repository connected, the status says so and every other team route is 409', async (t) => {
	const { call } = await setup(t);
	const status = await call('GET', '/team');
	assert.deepEqual([status.status, status.body], [200, { connected: false, repository: null, webUrl: null, branch: null, commit: null, fetchedAt: null, problem: '', problems: [], packages: [], installedOnly: [] }]);
	assert.deepEqual(code(await call('POST', '/team/refresh')), [409, 'NOT_CONNECTED']);
	assert.deepEqual(code(await call('PUT', '/team/packages/goodbyes/installed', { body: {} })), [409, 'NOT_CONNECTED']);
	assert.deepEqual(code(await call('POST', '/team/proposals', { body: { fileId: 'local:base.yml', package: 'goodbyes', summary: 'x' } })), [409, 'NOT_CONNECTED']);
});

test('connecting saves the address and lists the packages', async (t) => {
	const { service, call, remote } = await setup(t);
	await service.connectTeam(remote.url);
	assert.deepEqual(service.settings().teamRepositories, [remote.url]);
	const { body } = await call('GET', '/team');
	assert.deepEqual([body.connected, body.repository, body.branch, body.commit, body.problem], [true, remote.url, 'main', remote.head(), '']);
	assert.deepEqual(body.packages.map((pkg) => [pkg.name, pkg.matchCount, pkg.installed, pkg.updateAvailable]), [['goodbyes', 2, false, false], ['support', 4, false, false]]);
});

test('an address that is refused, or a repository that cannot be reached, changes nothing', async (t) => {
	const { service, call, remote, root } = await setup(t);
	await fails(service.connectTeam('ext::sh -c "touch /tmp/owned"'), (error) => assert.equal(error.code, 'INVALID'));
	assert.deepEqual(service.settings().teamRepositories, []);
	await service.connectTeam(remote.url);
	await fails(service.connectTeam(join(root, 'nowhere.git')), (error) => assert.deepEqual([error.code, error.kind], ['GIT_FAILED', 'unreachable']));
	assert.deepEqual(service.settings().teamRepositories, [remote.url]);
	assert.equal((await call('GET', '/team')).body.packages.length, 2);
});

test('installing puts the package where Espanso reads it, and the app lists it as a team package', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	await service.connectTeam(remote.url);
	const reply = await call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	assert.equal(reply.status, 200);
	assert.deepEqual(named(reply.body.packages).goodbyes.installed, true);
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

	const stale = named((await call('GET', '/team')).body.packages);
	assert.deepEqual([stale.goodbyes.updateAvailable, stale.support.updateAvailable], [false, false]);
	const refreshed = await call('POST', '/team/refresh');
	assert.equal(refreshed.status, 200);
	assert.deepEqual([named(refreshed.body.packages).goodbyes.updateAvailable, named(refreshed.body.packages).support.updateAvailable], [true, false]);
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':bye', 'Goodbye for now'], [':cheers', 'Cheers,']));

	const updated = await call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	assert.equal(named(updated.body.packages).goodbyes.updateAvailable, false);
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
	assert.equal(named((await call('GET', '/team')).body.packages).tools.runsCommands, true);
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
	assert.deepEqual([removed.status, named(removed.body.packages).goodbyes.installed], [200, false]);
	assert.equal(existsSync(join(matchDir, 'team', 'goodbyes')), false);
	assert.deepEqual(code(await call('DELETE', '/team/packages/goodbyes/installed')), [404, 'NOT_FOUND']);

	await service.disconnectTeam();
	assert.deepEqual(service.settings().teamRepositories, []);
	const status = (await call('GET', '/team')).body;
	assert.deepEqual([status.connected, status.packages, status.installedOnly], [false, [], [{ name: 'support' }]]);
	assert.equal(existsSync(join(matchDir, 'team', 'support', 'replies.yml')), true);
	assert.equal((await call('DELETE', '/team/packages/support/installed')).status, 200);
	assert.equal(existsSync(join(matchDir, 'team', 'support')), false);
});

test('a package the repository dropped stays installed and is listed apart', async (t) => {
	const { service, call, remote } = await setup(t);
	await service.connectTeam(remote.url);
	await call('PUT', '/team/packages/support/installed', { body: {} });
	remote.commit({ 'packages/support/_manifest.yml': null, 'packages/support/replies.yml': null, 'packages/support/escalations.yml': null });
	const { body } = await call('POST', '/team/refresh');
	assert.deepEqual([body.packages.map((pkg) => pkg.name), body.installedOnly], [['goodbyes'], [{ name: 'support' }]]);
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

test('connecting another repository replaces the first, and its copy is removed', async (t) => {
	const { service, call, remote, root } = await setup(t);
	await service.connectTeam(remote.url);
	const other = createRemote();
	other.commit({ 'packages/other/_manifest.yml': MANIFEST('other'), 'packages/other/package.yml': MATCHES([':o', 'Other']) });
	await service.connectTeam(other.url);
	assert.deepEqual(service.settings().teamRepositories, [other.url]);
	assert.deepEqual((await call('GET', '/team')).body.packages.map((pkg) => pkg.name), ['other']);
	assert.equal(readdirSync(join(root, 'data', 'team')).length, 1);
});

test('the app reconnects from its settings at the next start, and fetches in the background', async (t) => {
	const context = await setup(t);
	await context.service.connectTeam(context.remote.url);
	const newer = context.remote.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'See you']) });

	const again = await context.start(join(context.root, 'data'));
	await again.service.teamFetched();
	const { body } = await again.call('GET', '/team');
	assert.deepEqual([body.connected, body.commit, body.problem], [true, newer, '']);
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
	assert.match(body.problem, /^Git could not reach that repository\./);
	// What was fetched before is still there to browse.
	assert.equal(named(body.packages).goodbyes.installed, true);
	assert.equal((await again.call('GET', '/state')).body.files.length, 4);
	assert.deepEqual(code(await again.call('POST', '/team/refresh')), [502, 'GIT_FAILED']);

	// Once it answers again, the complaint goes away.
	cpSync(`${context.remote.url}.moved`, context.remote.url, { recursive: true });
	const recovered = await again.call('POST', '/team/refresh');
	assert.deepEqual([recovered.status, recovered.body.problem], [200, '']);
});

test('as the app runs it, a folder on this computer is never a repository address', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const remote = seeded();
	writeFileSync(join(root, 'settings.json'), JSON.stringify({ teamRepository: remote.url }));
	// No options: this is how the app itself starts the service.
	const service = await createService({ userDataDir: root, env: { SNIPPET_EDITOR_MATCH_DIR: join(root, 'match') } });
	t.after(() => service.dispose());
	await service.teamFetched();
	const status = await service.teamStatus();
	assert.deepEqual([status.connected, status.problem], [false, 'The saved team repository address is not one the app accepts. Connect it again in Settings.']);
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
	assert.deepEqual([body.connected, body.problem], [false, 'The saved team repository address is not one the app accepts. Connect it again in Settings.']);
});

// --- added after review -----------------------------------------------------------

test('the state the window reads says whether a repository is connected', async (t) => {
	const { service, call, remote, root } = await setup(t);
	assert.equal((await call('GET', '/state')).body.teamConnected, false);
	await service.connectTeam(remote.url);
	assert.equal((await call('GET', '/state')).body.teamConnected, true);
	const [copy] = readdirSync(join(root, 'data', 'team'));
	assert.ok(existsSync(join(root, 'data', 'team', copy, 'repo.git')));
	await service.disconnectTeam();
	assert.equal((await call('GET', '/state')).body.teamConnected, false);
	assert.deepEqual(readdirSync(join(root, 'data', 'team')), []);
});

test('when git stops working, the status still answers, and the repository can still be disconnected', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const remote = seeded();
	const real = createGit({ allowLocal: true, env: gitEnv(remote.root) });
	let broken = false;
	const git = (args, options) => (broken ? Promise.reject(Object.assign(new Error('Git is not installed on this computer.'), { code: 'GIT_FAILED', kind: 'missing' })) : real(args, options));
	git.stopAll = () => {};
	const service = await createService({ userDataDir: join(root, 'data'), env: { SNIPPET_EDITOR_MATCH_DIR: join(root, 'match') }, git, allowLocalRepositories: true });
	t.after(() => service.dispose());
	const handle = createRouter({ service, log: () => {} });
	await service.connectTeam(remote.url);

	broken = true;
	const reply = await handle({ method: 'GET', path: '/api/v1/team' });
	assert.deepEqual([reply.status, reply.body.connected, reply.body.repository, reply.body.problem, reply.body.packages], [200, true, remote.url, 'Git is not installed on this computer.', []]);
	assert.deepEqual(code(await handle({ method: 'POST', path: '/api/v1/team/refresh' })), [502, 'GIT_FAILED']);
	const after = await service.disconnectTeam();
	assert.deepEqual([after.connected, service.settings().teamRepositories], [false, []]);
});

test('a repository that connects but cannot be listed is still connected, says why, and can be left', async (t) => {
	const remote = seeded();
	const real = createGit({ allowLocal: true, env: gitEnv(remote.root) });
	const git = (args, options) => (args.includes('ls-tree') ? Promise.reject(Object.assign(new Error('Git sent more than the app can read.'), { code: 'GIT_FAILED', kind: 'too-large' })) : real(args, options));
	git.stopAll = () => {};
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const service = await createService({ userDataDir: join(root, 'data'), env: { SNIPPET_EDITOR_MATCH_DIR: join(root, 'match') }, git, allowLocalRepositories: true });
	t.after(() => service.dispose());
	const status = await service.connectTeam(remote.url);
	assert.deepEqual([status.connected, status.problem, status.packages], [true, 'Git sent more than the app can read.', []]);
	assert.equal((await service.disconnectTeam()).connected, false);
});

test('"check for updates" copies the repository again if the copy has gone', async (t) => {
	const { service, call, remote, root } = await setup(t);
	await service.connectTeam(remote.url);
	rmSync(join(root, 'data', 'team'), { recursive: true, force: true });
	const refreshed = await call('POST', '/team/refresh');
	assert.deepEqual([refreshed.status, refreshed.body.commit, refreshed.body.packages.length], [200, remote.head(), 2]);
});

test('an install that was cut short shows as needing an update, even though nothing changed in the repository', async (t) => {
	const { service, call, remote, matchDir } = await setup(t);
	await service.connectTeam(remote.url);
	await call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	const markerFile = join(matchDir, 'team', 'goodbyes', '.snippet-editor.json');
	const marker = JSON.parse(readFileSync(markerFile, 'utf8'));
	writeFileSync(markerFile, JSON.stringify({ ...marker, state: 'installing' }));
	assert.deepEqual(named((await call('GET', '/team')).body.packages).goodbyes.updateAvailable, true);
	const repaired = await call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	assert.equal(named(repaired.body.packages).goodbyes.updateAvailable, false);
});

test('a package the app did not read cannot be installed, because it was not checked for commands', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	const remote = seeded();
	const team = createTeam({
		dataDir: join(root, 'data'),
		address: parseRepositoryAddress(remote.url, { allowLocal: true }),
		git: createGit({ allowLocal: true, env: gitEnv(remote.root) }),
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

test('connecting twice at once copies the repository once', async (t) => {
	const { service, remote, root } = await setup(t);
	const [first, second] = await Promise.all([service.connectTeam(remote.url), service.connectTeam(remote.url)]);
	assert.deepEqual([first.connected, second.connected], [true, true]);
	const [copy, ...others] = readdirSync(join(root, 'data', 'team'));
	assert.deepEqual([others, readdirSync(join(root, 'data', 'team', copy)).sort()], [[], ['fetched-at', 'repo.git']]);
});

test('after the match folder changes, team packages are installed in the new folder', async (t) => {
	const { service, call, remote, root } = await setup(t);
	await service.connectTeam(remote.url);
	const other = join(root, 'other-match');
	mkdirSync(other);
	await service.setMatchDir(other);
	const reply = await call('PUT', '/team/packages/goodbyes/installed', { body: {} });
	assert.equal(named(reply.body.packages).goodbyes.installed, true);
	assert.equal(existsSync(join(other, 'team', 'goodbyes', 'package.yml')), true);
	assert.equal(existsSync(join(root, 'match', 'team')), false);
	assert.deepEqual((await call('GET', '/state')).body.team.map((pkg) => pkg.name), ['goodbyes']);
});

test('closing the app stops any git call still under way', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-teamapi-'));
	let stopped = 0;
	const git = createGit({ allowLocal: true });
	const watched = (args, options) => git(args, options);
	watched.stopAll = () => (stopped += 1);
	const service = await createService({ userDataDir: join(root, 'data'), env: { SNIPPET_EDITOR_MATCH_DIR: join(root, 'match') }, git: watched });
	service.dispose();
	assert.equal(stopped, 1);
});
