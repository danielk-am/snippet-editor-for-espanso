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

	const found = (host, owner, name, url) => {
		const repo = withoutGit(name);
		return { url: url(repo), host, owner, repo, webUrl: `https://${host}/${owner}/${repo}` };
	};

	let match;
	if ((match = SHORT.exec(text))) return found('github.com', match[1], match[2], (repo) => `https://github.com/${match[1]}/${repo}.git`);
	if ((match = HTTPS.exec(text))) return found(match[1], match[3], match[4], (repo) => `https://${match[1]}${match[2] ?? ''}/${match[3]}/${repo}.git`);
	if ((match = SCP.exec(text))) return found(match[1], match[2], match[3], (repo) => `git@${match[1]}:${match[2]}/${repo}.git`);
	if ((match = SSH.exec(text))) return found(match[1], match[3], match[4], (repo) => `ssh://git@${match[1]}${match[2] ?? ''}/${match[3]}/${repo}.git`);

	// Tests point the app at a repository in a temporary folder. The app
	// itself never passes this option, so no setting can switch it on.
	if (allowLocal && path.isAbsolute(text)) {
		return { url: text, host: 'local', owner: '', repo: withoutGit(path.basename(text)), webUrl: null };
	}

	throw invalid(`That is not a repository address. ${FORMS}`);
}

// Whether a link leads into the connected repository's own pages. The window
// asks the app to open pull request pages in the browser, and nothing else
// should be reachable through that request.
export function isTeamLink(url, webUrl) {
	if (typeof url !== 'string' || typeof webUrl !== 'string') return false;
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
