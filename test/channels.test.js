import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../core/apiRouter.js';
import { createService } from '../core/service.js';
import { parseRepositoryAddress } from '../core/teamAddress.js';
import { CHANNELS, EVENTS } from '../shared/channels.js';
import { MANIFEST, MATCHES, createRemote, localGit, seeded } from './helpers/teamRemote.js';
import { mainProcess, windowApi } from './helpers/window.js';

const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const ipc = readFileSync(new URL('../electron/ipc.js', import.meta.url), 'utf8');

function listIn(source, name) {
	const body = source.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`));
	assert.ok(body, `${name} list not found in preload.cjs`);
	return [...body[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('the preload allows exactly the channels the app declares', () => {
	assert.deepEqual(listIn(preload, 'CHANNELS').sort(), [...CHANNELS].sort());
	assert.deepEqual(listIn(preload, 'EVENTS').sort(), [...EVENTS].sort());
});

test('every declared channel has a handler in the main process', () => {
	const handled = [...ipc.matchAll(/handle\(\s*'([^']+)'/g)].map((m) => m[1]);
	assert.deepEqual(handled.sort(), [...CHANNELS].sort());
});

// --- the team channels, with the handlers the app registers ---------------------------------

const FIXTURES = fileURLToPath(new URL('./fixtures/match', import.meta.url));
const RUNS = 'matches:\n  - trigger: ":ip"\n    replace: "{{ip}}"\n    vars:\n      - name: ip\n        type: shell\n        params:\n          cmd: "ipconfig getifaddr en0"\n';
const NONE = { connected: false, repositories: [], installedOnly: [], problem: '' };
const REFUSED = { ok: false, error: { code: 'INVALID', message: 'That link is not part of a connected repository.' } };
const NOT_NAMED = { ok: false, error: { code: 'INVALID', message: 'No repository was named, so nothing was disconnected.' } };

const SECOND_BY_SSH = 'git@github.com:acme/second.git';
const idOf = (address) => parseRepositoryAddress(address).id;
const urlOf = (address) => parseRepositoryAddress(address).url;
const named = (packages) => Object.fromEntries(packages.map((pkg) => [pkg.name, pkg]));
const proposalsIn = (remote) => remote.branches().filter((branch) => branch.startsWith('snippet-editor/'));
const fails = async (promise, check) => {
	let caught;
	await promise.catch((error) => (caught = error));
	assert.ok(caught, 'expected a failure');
	check(caught);
};

// The app as it runs, where no folder is a repository address. Two team
// repositories have GitHub addresses, and git alone is pointed at a test
// repository when it is asked for one of them. Nothing reaches the network.
async function setup(t) {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-channels-'));
	const matchDir = join(root, 'match');
	cpSync(FIXTURES, matchDir, { recursive: true });
	const first = seeded();
	const second = createRemote();
	second.commit({
		'packages/goodbyes/_manifest.yml': MANIFEST('goodbyes'),
		'packages/goodbyes/package.yml': MATCHES([':bye', 'The other goodbye']),
		'packages/tools/_manifest.yml': MANIFEST('tools'),
		'packages/tools/package.yml': RUNS,
	});
	// An address with no test repository behind it never gets as far as git.
	const git = localGit(first.root, new Map([[urlOf('acme/first'), first.url], [urlOf('acme/second'), second.url], [SECOND_BY_SSH, second.url]]));
	const service = await createService({ userDataDir: join(root, 'data'), env: { SNIPPET_EDITOR_MATCH_DIR: matchDir }, git });
	t.after(() => service.dispose());
	const router = createRouter({ service, log: () => {} });
	return { matchDir, service, router, first, second, ...(await mainProcess({ service, router })) };
}

test('team:disconnect carries the id of the repository to leave, and with none given it changes nothing and says so', async (t) => {
	const { invoke, service } = await setup(t);
	const one = await invoke('team:connect', 'acme/first');
	assert.deepEqual([one.ok, one.data.repositories.map((repository) => [repository.id, repository.repository, repository.webUrl])], [true, [[idOf('acme/first'), urlOf('acme/first'), 'https://github.com/acme/first']]]);
	const two = await invoke('team:connect', SECOND_BY_SSH);
	assert.deepEqual([two.ok, two.data?.repositories.map((repository) => repository.repository)], [true, [urlOf('acme/first'), SECOND_BY_SSH]]);

	// Two connected, and which one is not said: neither goes, and the reply says so.
	const noId = [[], [undefined], [null]];
	for (const args of noId) assert.deepEqual(await invoke('team:disconnect', ...args), NOT_NAMED, JSON.stringify(args));
	assert.deepEqual([await service.teamStatus(), service.settings().teamRepositories], [two.data, [urlOf('acme/first'), SECOND_BY_SSH]]);
	const left = await invoke('team:disconnect', idOf(SECOND_BY_SSH));
	assert.deepEqual([left.ok, left.data.repositories.map((repository) => repository.repository)], [true, [urlOf('acme/first')]]);
	assert.deepEqual(left.data, await service.teamStatus());
	assert.deepEqual(service.settings().teamRepositories, [urlOf('acme/first')]);
	// Pressed twice, or an id that is not one: the list as it is.
	for (const id of [idOf(SECOND_BY_SSH), 'nothing', 42, { id: idOf('acme/first') }]) assert.deepEqual(await invoke('team:disconnect', id), left, JSON.stringify(id));

	// One connected: no id does not mean that one. A missing id never disconnects anything.
	for (const args of noId) assert.deepEqual(await invoke('team:disconnect', ...args), NOT_NAMED, JSON.stringify(args));
	assert.deepEqual([await service.teamStatus(), service.settings().teamRepositories], [left.data, [urlOf('acme/first')]]);
	assert.deepEqual(await invoke('team:disconnect', idOf('acme/first')), { ok: true, data: NONE });
	// None connected.
	assert.deepEqual(await invoke('team:disconnect'), NOT_NAMED);
});

test('team:openLink opens a link inside any connected repository, and nothing else', async (t) => {
	const { invoke, opened, router } = await setup(t);
	const inFirst = 'https://github.com/acme/first/tree/main/packages/goodbyes';
	const inSecond = 'https://github.com/acme/second/compare/main...snippet-editor/goodbyes-20261007-101500?expand=1';
	// With none connected, no link is inside one.
	for (const link of [inFirst, inSecond]) assert.deepEqual(await invoke('team:openLink', link), REFUSED, link);

	await invoke('team:connect', 'acme/first');
	assert.deepEqual([await invoke('team:openLink', inFirst), await invoke('team:openLink', inSecond)], [{ ok: true, data: true }, REFUSED]);
	await invoke('team:connect', 'acme/second');
	assert.deepEqual([await invoke('team:openLink', inSecond), await invoke('team:openLink', inFirst)], [{ ok: true, data: true }, { ok: true, data: true }]);
	assert.deepEqual(opened, [inFirst, inSecond, inFirst]);

	// The page a proposal to the second repository ends with.
	const sent = await router({ method: 'POST', path: '/api/v1/team/proposals', body: { fileId: 'local:dates.yml', package: 'goodbyes', summary: 'Share', repository: idOf('acme/second') } });
	assert.match(sent.body.compareUrl, /^https:\/\/github\.com\/acme\/second\/compare\/main\.\.\.snippet-editor\/goodbyes-\d{8}-\d{6}\?expand=1$/);
	assert.deepEqual(await invoke('team:openLink', sent.body.compareUrl), { ok: true, data: true });
	assert.equal(opened.at(-1), sent.body.compareUrl);

	const before = opened.length;
	for (const link of [
		'https://github.com/acme/third/compare/main...x',
		'https://github.com/acme/first-evil',
		'https://github.com/acme',
		'https://evil.example/acme/second/compare/main...x',
		'http://github.com/acme/second',
		'https://someone:secret@github.com/acme/second',
		'https://github.com/acme/second/../../evil/repo',
		'https://github.com/acme/second/..%2f..%2fthird',
		'https://github.com/acme/second/..%5C..%5Cthird',
		'https://github.com/acme/second/%2E%2e/second/compare/main...x',
		'file:///etc/hosts',
		'',
		undefined,
		42,
	]) {
		assert.deepEqual(await invoke('team:openLink', link), REFUSED, String(link));
	}

	// Disconnected since: its links open no more, and the other's still do.
	await invoke('team:disconnect', idOf('acme/second'));
	assert.deepEqual([await invoke('team:openLink', sent.body.compareUrl), await invoke('team:openLink', inSecond)], [REFUSED, REFUSED]);
	assert.equal(opened.length, before);
	assert.deepEqual(await invoke('team:openLink', inFirst), { ok: true, data: true });
	await invoke('team:disconnect', idOf('acme/first'));
	assert.deepEqual(await invoke('team:openLink', inFirst), REFUSED);
	assert.equal(opened.length, before + 1);
});

test('a team channel asked from anywhere but the app\'s own window does nothing', async (t) => {
	const { service, router } = await setup(t);
	await service.connectTeam('acme/first');
	const outside = await mainProcess({ service, router, trusted: () => false });
	const refused = { ok: false, error: { code: 'FORBIDDEN', message: 'Request refused.' } };
	assert.deepEqual(await outside.invoke('team:disconnect', idOf('acme/first')), refused);
	assert.deepEqual(await outside.invoke('team:openLink', 'https://github.com/acme/first'), refused);
	assert.deepEqual(await outside.invoke('team:connect', 'acme/second'), refused);
	assert.deepEqual([service.settings().teamRepositories, outside.opened], [[urlOf('acme/first')], []]);
});

test('the window\'s calls reach the routes and the channels, and say which repository they mean', async (t) => {
	const main = await setup(t);
	const { service, first, second, matchDir, opened } = main;
	const loaded = await windowApi(main);
	const { api } = loaded;
	// The pages read the status as the app answers it. Nothing stands between.
	assert.equal('oneRepository' in loaded, false);
	const [one, two] = [idOf('acme/first'), idOf('acme/second')];
	const of = (status, id) => status.repositories.find((repository) => repository.id === id);

	// The status is the app's own: every connected repository.
	assert.deepEqual(await api.team(), NONE);
	await fails(api.connectTeam('ext::sh -c "touch /tmp/owned"'), (error) => assert.equal(error.code, 'INVALID'));
	assert.deepEqual((await api.connectTeam('acme/first')).repositories.map((repository) => repository.id), [one]);
	const connected = await api.connectTeam('acme/second');
	assert.deepEqual(connected, await api.team());
	assert.deepEqual(connected, await service.teamStatus());
	assert.deepEqual(connected.repositories.map((repository) => [repository.id, repository.packages.map((pkg) => pkg.name)]), [[one, ['goodbyes', 'support']], [two, ['goodbyes', 'tools']]]);

	// Checking one, and checking all.
	const [mine, theirs] = [first.commit({ 'packages/support/replies.yml': MATCHES([':refund', 'Newer']) }), second.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Newer']) })];
	const checked = await api.refreshTeam(two);
	assert.deepEqual([of(checked, two).commit, of(checked, one).commit === mine], [theirs, false]);
	const later = second.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Newer again']) });
	const all = await api.refreshTeam();
	assert.deepEqual([of(all, one).commit, of(all, two).commit], [mine, later]);
	// A page with no repository to name holds null: that is all of them too.
	const [last, lastToo] = [first.commit({ 'packages/support/replies.yml': MATCHES([':refund', 'Newest']) }), second.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Newest']) })];
	assert.deepEqual((await api.refreshTeam(null)).repositories.map((repository) => repository.commit), [last, lastToo]);
	await fails(api.refreshTeam('nothing'), (error) => assert.deepEqual([error.code, error.message], ['NOT_FOUND', 'That repository is not connected.']));

	// Installing: from the one that offers the name, or from the one that is named.
	assert.equal(named(of(await api.installTeamPackage('support'), one).packages).support.installed, true);
	await fails(api.installTeamPackage('goodbyes'), (error) => {
		assert.equal(error.code, 'AMBIGUOUS');
		assert.equal(error.message, `Two repositories offer goodbyes: acme/first (${one}) and acme/second (${two}). Say which: set \`repository\` to one of the ids in brackets.`);
	});
	const installed = await api.installTeamPackage('goodbyes', { repository: two });
	assert.deepEqual([named(of(installed, two).packages).goodbyes.installed, named(of(installed, one).packages).goodbyes.installedFrom], [true, urlOf('acme/second')]);
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':bye', 'Newest']));
	await fails(api.installTeamPackage('goodbyes', { repository: one }), (error) => assert.deepEqual([error.code, error.message], ['EXISTS', 'A package named goodbyes is already installed from acme/second. Remove it first, then install this one.']));
	await fails(api.installTeamPackage('tools', { repository: two }), (error) => assert.match(error.message, /runs commands/));
	// A package a repository does not have is said of that repository, by name.
	await fails(api.installTeamPackage('tools', { repository: one }), (error) => assert.deepEqual([error.code, error.message], ['NOT_FOUND', 'acme/first has no package named tools.']));
	// A page with no repository to name sends none: null is not an id.
	await fails(api.installTeamPackage('tools', { repository: null }), (error) => assert.match(error.message, /runs commands/));
	// A name that is held means its holder, though both offer it.
	second.commit({ 'packages/goodbyes/package.yml': MATCHES([':bye', 'Newer than newest']) });
	await api.refreshTeam(two);
	assert.deepEqual((({ installed, updateAvailable }) => [installed, updateAvailable])(named(of(await api.installTeamPackage('goodbyes', { repository: null }), two).packages).goodbyes), [true, false]);
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':bye', 'Newer than newest']));
	assert.equal(named(of(await api.installTeamPackage('tools', { repository: two, acceptCommands: true }), two).packages).tools.installed, true);
	const removed = await api.removeTeamPackage('goodbyes');
	assert.deepEqual([named(of(removed, two).packages).goodbyes.installed, named(of(removed, one).packages).goodbyes.installedFrom], [false, '']);
	// Free again, it could be either.
	await fails(api.installTeamPackage('goodbyes', { repository: null }), (error) => assert.equal(error.code, 'AMBIGUOUS'));

	// Proposing: to the repository named, and its page opens.
	const proposal = { fileId: 'local:dates.yml', package: 'goodbyes', summary: 'Share the date snippets' };
	await fails(api.propose(proposal), (error) => assert.equal(error.code, 'AMBIGUOUS'));
	await fails(api.propose({ ...proposal, repository: null }), (error) => assert.equal(error.code, 'AMBIGUOUS'));
	const sent = await api.propose({ ...proposal, repository: two });
	assert.deepEqual([proposalsIn(second), proposalsIn(first)], [[sent.branch], []]);
	assert.equal(await api.openTeamLink(sent.compareUrl), true);
	assert.deepEqual(opened, [sent.compareUrl]);
	await fails(api.openTeamLink('https://github.com/acme/third'), (error) => assert.deepEqual([error.code, error.message], ['INVALID', 'That link is not part of a connected repository.']));

	// Disconnecting: the one named, and no other. With none named, none goes.
	for (const id of [undefined, null]) await fails(api.disconnectTeam(id), (error) => assert.deepEqual([error.code, error.message], ['INVALID', 'No repository was named, so nothing was disconnected.']));
	assert.deepEqual((await api.team()).repositories.map((repository) => repository.id), [one, two]);
	const left = await api.disconnectTeam(two);
	assert.deepEqual([left.repositories.map((repository) => repository.id), left.installedOnly], [[one], [{ name: 'tools', repository: urlOf('acme/second') }]]);
	await fails(api.openTeamLink(sent.compareUrl), (error) => assert.equal(error.code, 'INVALID'));
	assert.deepEqual((await api.disconnectTeam(one)).repositories, []);
});
