import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepositoryAddress, repositoryKey } from '../core/teamAddress.js';

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
