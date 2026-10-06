import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepositoryAddress } from '../core/teamAddress.js';

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
	});
});

test('an HTTPS address is taken with or without .git, a trailing slash or spaces around it', () => {
	const expected = {
		url: 'https://github.example.com/acme/team-snippets.git',
		host: 'github.example.com',
		owner: 'acme',
		repo: 'team-snippets',
		webUrl: 'https://github.example.com/acme/team-snippets',
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
	});
	assert.equal(parseRepositoryAddress('git@github.com:acme/team-snippets').url, 'git@github.com:acme/team-snippets.git');
	assert.deepEqual(parseRepositoryAddress('ssh://git@github.example.com:2222/acme/team-snippets.git'), {
		url: 'ssh://git@github.example.com:2222/acme/team-snippets.git',
		host: 'github.example.com',
		owner: 'acme',
		repo: 'team-snippets',
		webUrl: 'https://github.example.com/acme/team-snippets',
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
	});
});
