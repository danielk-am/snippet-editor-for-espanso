import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as teamAddress from '../core/teamAddress.js';
import { parseRepositoryAddress, repositoryKey } from '../core/teamAddress.js';
import { repositoryLabel } from '../shared/repositoryLabel.js';

const refused = (input, options) =>
	assert.throws(
		() => parseRepositoryAddress(input, options),
		(error) => error.code === 'INVALID',
		`${JSON.stringify(input)} should be refused`
	);

test('the short form means a repository on github.com over HTTPS', () => {
	assert.deepEqual(parseRepositoryAddress('acme/team-snippets'), {
		url: 'https://github.com/acme/team-snippets.git',
		host: 'github.com',
		owner: 'acme',
		repo: 'team-snippets',
		webUrl: 'https://github.com/acme/team-snippets',
		key: 'github.com/acme/team-snippets',
		id: '980ba86f6835',
	});
});

test('an HTTPS address is taken with or without .git, a trailing slash or spaces around it', () => {
	const expected = {
		url: 'https://github.example.com/acme/team-snippets.git',
		host: 'github.example.com',
		owner: 'acme',
		repo: 'team-snippets',
		webUrl: 'https://github.example.com/acme/team-snippets',
		key: 'github.example.com/acme/team-snippets',
		id: '14abaf476cd4',
	};
	for (const input of [
		'https://github.example.com/acme/team-snippets',
		'https://github.example.com/acme/team-snippets.git',
		'https://github.example.com/acme/team-snippets/',
		'  https://github.example.com/acme/team-snippets.git  ',
	]) {
		assert.deepEqual(parseRepositoryAddress(input), expected, input);
	}
});

test('the two SSH forms are kept as SSH, and the web address drops the port', () => {
	assert.deepEqual(parseRepositoryAddress('git@github.com:acme/team-snippets.git'), {
		url: 'git@github.com:acme/team-snippets.git',
		host: 'github.com',
		owner: 'acme',
		repo: 'team-snippets',
		webUrl: 'https://github.com/acme/team-snippets',
		key: 'github.com/acme/team-snippets',
		id: 'cda6f9e4bdce',
	});
	assert.equal(parseRepositoryAddress('git@github.com:acme/team-snippets').url, 'git@github.com:acme/team-snippets.git');
	assert.deepEqual(parseRepositoryAddress('ssh://git@github.example.com:2222/acme/team-snippets.git'), {
		url: 'ssh://git@github.example.com:2222/acme/team-snippets.git',
		host: 'github.example.com',
		owner: 'acme',
		repo: 'team-snippets',
		webUrl: 'https://github.example.com/acme/team-snippets',
		key: 'github.example.com/acme/team-snippets',
		id: 'ecf40a5a84f1',
	});
});

test('anything that is not a repository address is refused', () => {
	for (const input of [
		'',
		'   ',
		'team-snippets',
		'acme/team/snippets',
		'https://github.com/acme',
		'https://github.com/acme/team/extra',
		'http://github.com/acme/team-snippets',
		'ftp://github.com/acme/team-snippets',
		'file:///Users/someone/repo',
		'/Users/someone/repo',
		'../repo',
		'ext::sh -c "touch /tmp/owned"',
		'--upload-pack=touch /tmp/owned',
		'-oProxyCommand=evil',
		'git@github.com:acme/team snippets.git',
		'git@github.com:-acme/team.git',
		'https://github.com/acme/team\nsnippets',
		'https://github.com/acme/..',
		'https://github.com/./team',
		`acme/${'x'.repeat(300)}`,
		42,
		null,
		undefined,
	]) {
		refused(input);
	}
});

test('an address that carries a user name or a password is refused, and says why', () => {
	for (const input of ['https://someone:ghp_secret@github.com/acme/team-snippets.git', 'https://token@github.com/acme/team-snippets']) {
		assert.throws(
			() => parseRepositoryAddress(input),
			(error) => error.code === 'INVALID' && /user name or password/.test(error.message) && !error.message.includes('ghp_secret'),
			input
		);
	}
});

test('a folder on this computer is an address only when the caller allows it', () => {
	refused('/tmp/remotes/team.git');
	assert.deepEqual(parseRepositoryAddress('/tmp/remotes/team.git', { allowLocal: true }), {
		url: '/tmp/remotes/team.git',
		host: 'local',
		owner: '',
		repo: 'team',
		webUrl: null,
		key: 'local//tmp/remotes/team.git',
		id: '627e32677023',
	});
	refused('relative/path/to/repo.git', { allowLocal: true });
	assert.equal(parseRepositoryAddress('acme/team-snippets', { allowLocal: true }).host, 'github.com');
});

test('only a link inside the connected repository on its own host may be opened', async () => {
	const { isTeamLink } = await import('../core/teamAddress.js');
	const web = 'https://github.com/acme/team';
	for (const url of [
		'https://github.com/acme/team',
		'https://github.com/acme/team/compare/main...snippet-editor/goodbyes-20261006-101500?expand=1',
		'https://github.com/acme/team/tree/main/packages/goodbyes',
		// Other encodings in the path are left alone, and so is whatever follows it.
		'https://github.com/acme/team/compare/main...snippet-editor/caf%C3%A9-20261006-101500',
		'https://github.com/acme/team/compare/main...x?expand=1&title=a%2Fb%2E%5C',
		'https://github.com/acme/team/tree/main#L1%2F2',
	]) {
		assert.equal(isTeamLink(url, web), true, url);
	}
	for (const url of [
		'http://github.com/acme/team/compare/main...x',
		'https://evil.example/acme/team/compare/main...x',
		'https://github.com.evil.example/acme/team/compare/main...x',
		'https://github.com@evil.example/acme/team',
		'https://someone:secret@github.com/acme/team',
		'https://github.com/evil/repo/compare/main...x',
		'https://github.com/acme/team-evil/compare/main...x',
		'https://github.com/acme/team/../../evil/repo',
		// An encoded slash or backslash is one path segment to this app and can
		// be a separator to whoever answers the link. An encoded dot can be a
		// step up that the address bar would not show. None is in a link the
		// app makes, so a link that holds one is not opened.
		'https://github.com/acme/team/..%2f..%2fthird',
		'https://github.com/acme/team/..%2F..%2Fthird',
		'https://github.com/acme/team/..%5c..%5cthird',
		'https://github.com/acme/team/..%5C..%5Cthird',
		'https://github.com/acme/team/tree/main%2fpackages',
		'https://github.com/acme/team/%2e%2e/%2e%2e/evil/repo',
		'https://github.com/acme/team/%2e%2e/team/compare/main...x',
		'https://github.com/acme/team/.%2E/team',
		'https://github.com/acme/team/%2E/tree/main',
		'https://github.com/acme/team/tree/main/a%2eb',
		'https://github.com/acme/team%2f..%2f..%2fevil/repo',
		'https://github.com/acme%2Fteam',
		'https://github%2Ecom/acme/team',
		'https://github.com/acme/team/..%2f..%2fthird?expand=1#top',
		'javascript:alert(1)',
		'file:///etc/hosts',
		'github.com/acme/team',
		'',
		42,
		null,
	]) {
		assert.equal(isTeamLink(url, web), false, String(url));
	}
	assert.equal(isTeamLink('https://github.com/acme/team', null), false);
});

test('an HTTPS address with a port keeps that port in its web address', () => {
	assert.deepEqual(parseRepositoryAddress('https://ghe.example.com:8443/acme/team'), {
		url: 'https://ghe.example.com:8443/acme/team.git',
		host: 'ghe.example.com',
		owner: 'acme',
		repo: 'team',
		webUrl: 'https://ghe.example.com:8443/acme/team',
		key: 'ghe.example.com/acme/team',
		id: '75ca8d9eb249',
	});
});

// --- several team repositories ------------------------------------------------

test('every address form of one repository has one key, in lower case', () => {
	const forms = [
		'acme/team-snippets',
		'Acme/Team-Snippets',
		'https://github.com/acme/team-snippets',
		'https://github.com/acme/team-snippets.git',
		'https://GitHub.com/ACME/team-snippets/',
		'git@github.com:acme/team-snippets.git',
		'git@github.com:acme/team-snippets',
		'git@github.com:acme/Team-Snippets.GIT',
		'ssh://git@github.com/acme/team-snippets.git',
		'ssh://git@github.com:22/acme/team-snippets',
		'https://github.com:443/acme/team-snippets',
	];
	for (const input of forms) {
		assert.equal(parseRepositoryAddress(input).key, 'github.com/acme/team-snippets', input);
		assert.equal(repositoryKey(input), 'github.com/acme/team-snippets', input);
	}
});

test('a different host, owner or name is a different repository', () => {
	const keys = ['acme/team-snippets', 'acme/team', 'other/team-snippets', 'https://github.example.com/acme/team-snippets', 'acme/team-snippets.io', 'acme/team_snippets'].map((input) => parseRepositoryAddress(input).key);
	assert.deepEqual(keys, [
		'github.com/acme/team-snippets',
		'github.com/acme/team',
		'github.com/other/team-snippets',
		'github.example.com/acme/team-snippets',
		'github.com/acme/team-snippets.io',
		'github.com/acme/team_snippets',
	]);
});

test('the id is the first twelve characters of the hash of the address git is given, so each form has its own', () => {
	const https = parseRepositoryAddress('https://github.com/acme/team-snippets');
	const short = parseRepositoryAddress('acme/team-snippets');
	const scp = parseRepositoryAddress('git@github.com:acme/team-snippets.git');
	const ssh = parseRepositoryAddress('ssh://git@github.com/acme/team-snippets.git');
	// The short form is the HTTPS address, so the two are one copy on disk.
	assert.deepEqual([https.url, short.url], ['https://github.com/acme/team-snippets.git', 'https://github.com/acme/team-snippets.git']);
	assert.deepEqual([https.id, short.id, scp.id, ssh.id], ['980ba86f6835', '980ba86f6835', 'cda6f9e4bdce', '9fd61c301a20']);
	assert.deepEqual(new Set([https.key, short.key, scp.key, ssh.key]), new Set(['github.com/acme/team-snippets']));
	for (const address of [https, scp, ssh]) assert.match(address.id, /^[0-9a-f]{12}$/);
});

test('a folder on this computer has a key of its own, and only when the caller allows it', () => {
	const one = parseRepositoryAddress('/tmp/remotes/one/remote.git', { allowLocal: true });
	const two = parseRepositoryAddress('/tmp/remotes/two/remote.git', { allowLocal: true });
	// Both folders are named remote.git: the key is the whole path, not the name.
	assert.deepEqual([one.repo, two.repo], ['remote', 'remote']);
	assert.deepEqual([one.key, two.key], ['local//tmp/remotes/one/remote.git', 'local//tmp/remotes/two/remote.git']);
	assert.notEqual(one.id, two.id);
	// The same folder written with a slash at its end is the same repository, under another id.
	const slashed = parseRepositoryAddress('/tmp/remotes/one/remote.git/', { allowLocal: true });
	assert.deepEqual([slashed.url, slashed.key, slashed.id === one.id], ['/tmp/remotes/one/remote.git/', one.key, false]);
	// Capitals are kept: on many disks two such folders are two folders.
	assert.notEqual(parseRepositoryAddress('/tmp/Remotes/one/remote.git', { allowLocal: true }).key, one.key);

	assert.equal(repositoryKey('/tmp/remotes/one/remote.git', { allowLocal: true }), 'local//tmp/remotes/one/remote.git');
	assert.equal(repositoryKey('/tmp/remotes/one/remote.git'), '');
	assert.equal(repositoryKey('/tmp/remotes/one/remote.git', {}), '');
});

test('text that is not an address has no key, and asking never throws', () => {
	for (const input of ['', '   ', 'team-snippets', 'ext::sh -c "touch /tmp/owned"', '--upload-pack=x', 'https://someone:secret@github.com/acme/team', 'http://github.com/acme/team', `acme/${'x'.repeat(300)}`, 42, null, undefined, {}, ['acme/team']]) {
		assert.equal(repositoryKey(input), '', String(input).slice(0, 40));
		assert.equal(repositoryKey(input, { allowLocal: true }), '', String(input).slice(0, 40));
	}
	assert.equal(repositoryKey('  acme/team-snippets  '), 'github.com/acme/team-snippets');
});

// --- how a repository is named for a person ---------------------------------------------

test('a repository is named by its owner and name, whichever form its address has', () => {
	for (const input of ['acme/team-snippets', 'https://github.com/acme/team-snippets.git', 'git@github.com:acme/team-snippets.git', 'ssh://git@github.com:22/acme/team-snippets', 'https://GitHub.com/acme/team-snippets']) {
		assert.equal(repositoryLabel(parseRepositoryAddress(input).url), 'acme/team-snippets', input);
	}
	// As it was typed, capitals and all: this is for a person to read, not for comparing.
	assert.equal(repositoryLabel(parseRepositoryAddress('https://github.com/Acme/Team.git').url), 'Acme/Team');
	// A folder, which only a test connects, has no owner. Its path stands in.
	assert.equal(repositoryLabel(parseRepositoryAddress('/tmp/remotes/one/remote.git', { allowLocal: true }).url), '/tmp/remotes/one/remote.git');
});

test('a repository on a host of its own is named with that host, so two of one owner and name are told apart', () => {
	// The same owner and name on GitHub and on a company's own GitHub are two
	// repositories. Both can be connected, and each has to read as itself in a
	// choice, a heading, a question and a refusal.
	const onGitHub = parseRepositoryAddress('https://github.com/acme/team');
	const onTheirOwn = parseRepositoryAddress('git@ghe.corp.example:acme/team.git');
	assert.notEqual(onGitHub.key, onTheirOwn.key);
	assert.deepEqual([repositoryLabel(onGitHub.url), repositoryLabel(onTheirOwn.url)], ['acme/team', 'ghe.corp.example/acme/team']);
	// Every form of one repository's address reads the same. A port is not
	// part of which repository it is, and nor are capitals in the host.
	for (const input of ['https://ghe.corp.example/acme/team', 'https://ghe.corp.example:8443/acme/team.git', 'git@ghe.corp.example:acme/team', 'ssh://git@ghe.corp.example/acme/team.git', 'ssh://git@ghe.corp.example:2222/acme/team', 'https://GHE.Corp.Example/acme/team']) {
		const address = parseRepositoryAddress(input);
		assert.deepEqual([address.key, repositoryLabel(address.url)], [onTheirOwn.key, 'ghe.corp.example/acme/team'], input);
	}
	// The owner and name stay as typed.
	assert.equal(repositoryLabel(parseRepositoryAddress('https://ghe.example.com:8443/Acme/Team.git').url), 'ghe.example.com/Acme/Team');
	// A host that only looks like GitHub is another host, and says so.
	for (const [input, label] of [['https://github.com.evil.example/acme/team', 'github.com.evil.example/acme/team'], ['git@notgithub.com:acme/team.git', 'notgithub.com/acme/team'], ['https://www.github.com/acme/team', 'www.github.com/acme/team']]) {
		assert.equal(repositoryLabel(parseRepositoryAddress(input).url), label, input);
	}
});

test('the name is the owner and name the address was parsed into, with the host unless it is GitHub, for every form the app keeps', () => {
	const owners = ['acme', 'Acme-Org', 'a', 'a.b_c-d', '0day'];
	const repos = ['team-snippets', 'Team.Snippets', 'x', 'snippets.git.git', 'a.git-b', 'dot.', 'under_score', '9'];
	const forms = [
		(owner, repo) => `${owner}/${repo}`,
		(owner, repo) => `https://github.com/${owner}/${repo}`,
		(owner, repo) => `https://github.com/${owner}/${repo}.git/`,
		(owner, repo) => `https://ghe.example.com:8443/${owner}/${repo}.git`,
		(owner, repo) => `git@github.com:${owner}/${repo}.git`,
		(owner, repo) => `git@ghe.example.com:${owner}/${repo}`,
		(owner, repo) => `ssh://git@github.com/${owner}/${repo}.git`,
		(owner, repo) => `ssh://git@ghe.example.com:2222/${owner}/${repo}`,
	];
	let checked = 0;
	for (const owner of owners) {
		for (const repo of repos) {
			for (const form of forms) {
				const address = parseRepositoryAddress(form(owner, repo));
				// On GitHub itself the owner and name are enough. Anywhere else the host comes first.
				const expected = address.host === 'github.com' ? `${address.owner}/${address.repo}` : `${address.host}/${address.owner}/${address.repo}`;
				assert.equal(repositoryLabel(address.url), expected, address.url);
				checked += 1;
			}
		}
	}
	assert.equal(checked, owners.length * repos.length * forms.length);
	// One ".git" is the address's own ending. Any before it belongs to the name.
	assert.equal(repositoryLabel('https://github.com/acme/snippets.git.git'), 'acme/snippets.git');
});

test('text that is not an address the app keeps is named as it is, and nothing but text is named at all', () => {
	for (const text of [
		'',
		'acme/team-snippets',
		'https://github.com/acme/team-snippets',
		'https://github.com/acme/team-snippets.GIT',
		'https://github.com/acme.git',
		'https://github.com/acme/team/snippets.git',
		'https://someone:secret@github.com/acme/team-snippets.git',
		'http://github.com/acme/team-snippets.git',
		'git@github.com:acme/team/snippets.git',
		'ssh://someone@github.com/acme/team-snippets.git',
		'file:///tmp/acme/team-snippets.git',
		'ext::sh -c "touch /tmp/owned" acme/team.git',
		' https://github.com/acme/team-snippets.git',
		'https://github.com/acme/team-snippets.git\n',
		'/tmp/remotes/one/remote.git',
		'C:\\remotes\\one\\remote.git',
	]) {
		assert.equal(repositoryLabel(text), text, JSON.stringify(text));
	}
	for (const value of [undefined, null, 42, true, {}, [], ['https://github.com/acme/team.git'], { url: 'https://github.com/acme/team.git', owner: 'acme', repo: 'team' }]) {
		assert.equal(repositoryLabel(value), '', JSON.stringify(value));
	}
	// A very long text is answered at once, as it is.
	const long = `https://github.com/${'a'.repeat(200_000)}/${'b.'.repeat(200_000)}`;
	const started = Date.now();
	assert.equal(repositoryLabel(long), long);
	assert.equal(repositoryLabel(`${long}.git`).length, 600_001);
	assert.ok(Date.now() - started < 1000, 'naming a very long text took too long');
});

test('there is one function that names a repository, and the window can load it', () => {
	// The window cannot load Node's modules or anything in core/.
	const source = readFileSync(new URL('../shared/repositoryLabel.js', import.meta.url), 'utf8');
	assert.doesNotMatch(source, /\bimport\b|\brequire\(/);
	// Nothing else writes the name: the address module no longer has its own.
	assert.deepEqual(Object.keys(teamAddress).sort(), ['isTeamLink', 'parseRepositoryAddress', 'repositoryKey']);
	const written = /\$\{[^}]*\bowner\}\/\$\{[^}]*\brepo\}/;
	for (const file of ['core/apiRouter.js', 'core/team.js', 'core/teamPackages.js', 'core/service.js', 'core/chat/proposals.js', 'mcp/tools.mjs', 'electron/ipc.js', 'renderer/lib/api.js', 'renderer/components/SettingsPage.js', 'renderer/components/TeamPage.js', 'renderer/components/ProposeDialog.js']) {
		assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), written, `${file} writes owner/repo by itself`);
	}
});
