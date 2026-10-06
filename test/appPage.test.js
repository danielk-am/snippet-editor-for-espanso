// The main process answers only its own page. If this comparison is wrong on
// some system, every request is refused and the app cannot open, so it is
// tested for each system's path rules, not just the one the tests run on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSameFile } from '../core/appPage.js';

const MAC = '/Applications/Snippet Editor.app/Contents/Resources/app.asar/renderer/index.html';
const WIN = 'C:\\Program Files\\Snippet Editor\\resources\\app.asar\\renderer\\index.html';
const LINUX = '/tmp/.mount_SnippeAbCdEf/resources/app.asar/renderer/index.html';

test('the page URL of the packaged app matches its file on macOS', () => {
	const url = 'file:///Applications/Snippet%20Editor.app/Contents/Resources/app.asar/renderer/index.html';
	assert.equal(isSameFile(url, MAC, 'darwin'), true);
});

test('a query or fragment on the URL does not matter', () => {
	const url = 'file:///Applications/Snippet%20Editor.app/Contents/Resources/app.asar/renderer/index.html?x=1#top';
	assert.equal(isSameFile(url, MAC, 'darwin'), true);
});

test('the page URL matches its file on Windows, whatever the case of the drive letter', () => {
	for (const url of [
		'file:///C:/Program%20Files/Snippet%20Editor/resources/app.asar/renderer/index.html',
		'file:///c:/Program%20Files/Snippet%20Editor/resources/app.asar/renderer/index.html',
		'file:///C:/program%20files/snippet%20editor/resources/app.asar/renderer/INDEX.html',
	]) {
		assert.equal(isSameFile(url, WIN, 'win32'), true, url);
	}
});

test('the page URL matches its file on Linux, where case does matter', () => {
	assert.equal(isSameFile('file:///tmp/.mount_SnippeAbCdEf/resources/app.asar/renderer/index.html', LINUX, 'linux'), true);
	assert.equal(isSameFile('file:///tmp/.mount_snippeabcdef/resources/app.asar/renderer/index.html', LINUX, 'linux'), false);
});

test('another file, another scheme or nonsense is not the app page', () => {
	assert.equal(isSameFile('file:///Applications/Snippet%20Editor.app/Contents/Resources/app.asar/renderer/other.html', MAC, 'darwin'), false);
	assert.equal(isSameFile('file:///Applications/Snippet%20Editor.app/Contents/Resources/app.asar/renderer/index.html/../../evil.html', MAC, 'darwin'), false);
	assert.equal(isSameFile('https://example.com/renderer/index.html', MAC, 'darwin'), false);
	assert.equal(isSameFile('file://evil.example/Applications/Snippet%20Editor.app/Contents/Resources/app.asar/renderer/index.html', MAC, 'darwin'), false);
	assert.equal(isSameFile('', MAC, 'darwin'), false);
	assert.equal(isSameFile(undefined, MAC, 'darwin'), false);
	assert.equal(isSameFile('file:///D:/Program%20Files/Snippet%20Editor/resources/app.asar/renderer/index.html', WIN, 'win32'), false);
});
