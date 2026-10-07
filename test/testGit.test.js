// The tests run the real git against repositories in temporary folders. This
// is the guard that keeps every one of them off the network: if a check in
// the app that should have refused an address ever gave way, the test that
// leans on it fails here, and nothing is asked of a real server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { offline } from './helpers/teamRemote.js';

test('a test\'s git stops an address with no test repository behind it, before git is called', async () => {
	const calls = [];
	const real = async (args, options) => (calls.push([args, options]), 'ran');
	real.stopAll = () => calls.push('stopped');
	const git = offline(real, new Map([['https://github.com/acme/team.git', '/tmp/remotes/team.git']]));

	for (const stray of [
		'https://github.com/acme/other.git',
		'https://github.com/acme/team',
		'http://github.com/acme/team.git',
		'ssh://git@github.com/acme/team.git',
		'git@github.com:acme/team.git',
		'https://someone:secret@github.com/acme/team',
		'HTTPS://github.com/acme/other.git',
		'Git@github.com:acme/team.git',
	]) {
		await assert.rejects(git(['clone', '--quiet', '--', stray, '/tmp/copy'], { cwd: '/tmp' }), { message: `This test has no repository for ${stray}.` }, stray);
		await assert.rejects(git(['ls-remote', stray]), { message: `This test has no repository for ${stray}.` }, stray);
	}
	assert.deepEqual(calls, []);

	// An address with a folder behind it is handed on as that folder. A
	// folder, and everything that is no address, is handed on as it is.
	assert.equal(await git(['clone', '--', 'https://github.com/acme/team.git', '/tmp/copy'], { cwd: '/tmp' }), 'ran');
	assert.equal(await git(['clone', '--', '/tmp/remotes/other.git', '/tmp/copy']), 'ran');
	assert.equal(await git(['fetch', '--prune', 'origin', '+refs/heads/main:refs/heads/main']), 'ran');
	assert.deepEqual(calls, [
		[['clone', '--', '/tmp/remotes/team.git', '/tmp/copy'], { cwd: '/tmp' }],
		[['clone', '--', '/tmp/remotes/other.git', '/tmp/copy'], undefined],
		[['fetch', '--prune', 'origin', '+refs/heads/main:refs/heads/main'], undefined],
	]);
	// With no folders given, every address is a stray.
	await assert.rejects(offline(real)(['clone', 'https://github.com/acme/team.git']), /^Error: This test has no repository for/);
	git.stopAll();
	assert.equal(calls.at(-1), 'stopped');
});

test('no test hands the app a git of its own making: each goes through the guard', () => {
	// test/git.test.js tests git's own wrapper, with stand-ins for the program.
	// This file names the function only to look for it.
	const own = ['git.test.js', 'testGit.test.js'];
	const folder = new URL('.', import.meta.url);
	const files = [...readdirSync(folder).filter((name) => /\.(test\.js|mjs)$/.test(name)), 'mcp-eval/serve.mjs'].filter((name) => !own.includes(name));
	assert.ok(files.includes('team.test.js') && files.includes('ui-smoke.mjs'));
	for (const name of files) assert.doesNotMatch(readFileSync(new URL(name, folder), 'utf8'), /\bcreateGit\b/, `${name} makes its own git: use localGit or offline from helpers/teamRemote.js`);
});
