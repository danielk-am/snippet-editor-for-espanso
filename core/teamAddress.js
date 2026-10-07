import { createHash } from 'node:crypto';
import path from 'node:path';

// A team repository's address, as a person types it. Only the forms listed
// here are accepted, because the address ends up as an argument to git, and
// git has transports (ext::, file:) and options (a leading dash) that must
// never be reachable from a text field.

const NAME = '[A-Za-z0-9][A-Za-z0-9._-]*';
const HOST = '[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?';

const SHORT = new RegExp(`^(${NAME})/(${NAME})$`);
const HTTPS = new RegExp(`^https://(${HOST})(:\\d{1,5})?/(${NAME})/(${NAME})/?$`);
const SCP = new RegExp(`^git@(${HOST}):(${NAME})/(${NAME})$`);
const SSH = new RegExp(`^ssh://git@(${HOST})(:\\d{1,5})?/(${NAME})/(${NAME})$`);

const FORMS = 'Use owner/repo, https://github.com/owner/repo, or git@github.com:owner/repo.git.';

const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID' });

const hasControlOrSpace = (text) =>
	[...text].some((character) => {
		const code = character.codePointAt(0);
		return code <= 0x20 || code === 0x7f;
	});

const withoutGit = (name) => (name.toLowerCase().endsWith('.git') ? name.slice(0, -4) : name);

// `key` says which repository an address means: its host, owner and name,
// whichever form was typed. Two addresses with one key are one repository.
// `id` names the app's copy of it, and is the folder that copy is kept in. It
// comes from the address git is given, so it stays what it was before there
// could be several.
const identified = (address, key) => ({ ...address, key, id: createHash('sha256').update(address.url).digest('hex').slice(0, 12) });

export function parseRepositoryAddress(input, { allowLocal = false } = {}) {
	if (typeof input !== 'string') throw invalid(`That is not a repository address. ${FORMS}`);
	const text = input.trim();
	if (!text || text.length > 300 || hasControlOrSpace(text) || text.startsWith('-')) {
		throw invalid(`That is not a repository address. ${FORMS}`);
	}

	// A sign-in written into the address would be saved with the settings.
	if (/^https:\/\/[^/]*@/.test(text)) {
		throw invalid('Remove the user name or password from the address. The app uses the sign-in git already has, and saves none of its own.');
	}

	// `webPort` is the port of an HTTPS address, which its web pages share.
	// An SSH port says nothing about where the web pages are.
	const found = (host, owner, name, url, webPort = '') => {
		const repo = withoutGit(name);
		return identified({ url: url(repo), host, owner, repo, webUrl: `https://${host}${webPort}/${owner}/${repo}` }, `${host}/${owner}/${repo}`.toLowerCase());
	};

	let match;
	if ((match = SHORT.exec(text))) return found('github.com', match[1], match[2], (repo) => `https://github.com/${match[1]}/${repo}.git`);
	if ((match = HTTPS.exec(text))) return found(match[1], match[3], match[4], (repo) => `https://${match[1]}${match[2] ?? ''}/${match[3]}/${repo}.git`, match[2] ?? '');
	if ((match = SCP.exec(text))) return found(match[1], match[2], match[3], (repo) => `git@${match[1]}:${match[2]}/${repo}.git`);
	if ((match = SSH.exec(text))) return found(match[1], match[3], match[4], (repo) => `ssh://git@${match[1]}${match[2] ?? ''}/${match[3]}/${repo}.git`);

	// Tests point the app at a repository in a temporary folder. The app
	// itself never passes this option, so no setting can switch it on.
	if (allowLocal && path.isAbsolute(text)) {
		// A folder is known by its whole path: two test repositories often share
		// a folder name. A slash at the end is still the same folder.
		return identified({ url: text, host: 'local', owner: '', repo: withoutGit(path.basename(text)), webUrl: null }, `local/${text.replace(/[\\/]+$/, '') || text}`);
	}

	throw invalid(`That is not a repository address. ${FORMS}`);
}

// Which repository an address means, or '' when the text is not an address.
// A marker file or a settings file can hold anything, so this never throws.
export function repositoryKey(url, { allowLocal = false } = {}) {
	try {
		return parseRepositoryAddress(url, { allowLocal }).key;
	} catch {
		return '';
	}
}

// Whether a link leads into one repository's own pages. The window asks the
// app to open pull request pages in the browser, and nothing else should be
// reachable through that request. With several repositories connected, the
// caller asks this of each.
export function isTeamLink(url, webUrl) {
	if (typeof url !== 'string' || typeof webUrl !== 'string') return false;
	// An encoded slash or backslash is part of one path segment here, and can
	// be a separator to whoever answers the link. An encoded dot can be a step
	// up that is never seen. So "..%2f..%2fother" would pass for a page of this
	// repository and could open another's. The app makes no link with any of
	// the three in its path, so a link that has one is not opened. The path is
	// read as it was written, before any tidying. What follows it, after "?"
	// or "#", is not part of where the link leads.
	if (/%(?:2f|5c|2e)/i.test(url.split(/[?#]/)[0])) return false;
	let link;
	let base;
	try {
		link = new URL(url);
		base = new URL(webUrl);
	} catch {
		return false;
	}
	if (link.protocol !== 'https:' || link.username || link.password || link.origin !== base.origin) return false;
	// Compared after the browser's own tidying of "..", so a path cannot
	// climb out of the repository.
	return link.pathname === base.pathname || link.pathname.startsWith(`${base.pathname}/`);
}
