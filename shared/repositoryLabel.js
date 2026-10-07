// How a team repository is named for a person: its owner and name, as in
// "acme/team-snippets". Every message, card and page that names a repository
// gets the name here, so that they all say the same thing.
//
// A repository on GitHub itself is named by owner and name alone. One on a
// host of its own, such as a company's GitHub Enterprise, has that host in
// front: "ghe.corp.example/acme/team-snippets". The same owner and name on
// two hosts are two repositories, and both can be connected. Without the
// host they would read alike in a choice, a heading and a refusal.
//
// It is given the address as the app keeps it, which is what
// core/teamAddress.js made of what was typed: one of the three forms below,
// always ending in ".git". A folder, which only a test connects, has no
// owner, so its path stands in for the name. So does any other text that is
// none of the three: nothing is guessed from it.
//
// This file loads nothing else, so the window can use it as well as the app.

const NAME = '[A-Za-z0-9][A-Za-z0-9._-]*';
const HOST = '[^/:@\\s]+';
const PORT = '(?::\\d+)?';
// https://host/owner/repo.git, git@host:owner/repo.git and
// ssh://git@host/owner/repo.git. A host may carry a port, and never a sign-in.
const KEPT = new RegExp(`^(?:https://(${HOST})${PORT}/|git@(${HOST}):|ssh://git@(${HOST})${PORT}/)(${NAME})/(${NAME})\\.git$`);

export function repositoryLabel(url) {
	if (typeof url !== 'string') return '';
	const kept = KEPT.exec(url);
	if (!kept) return url;
	// The host says which repository it is in any capitals, and its port does
	// not, as in the address's own key. The owner and name stay as typed.
	const host = (kept[1] ?? kept[2] ?? kept[3]).toLowerCase();
	const name = `${kept[4]}/${kept[5]}`;
	return host === 'github.com' ? name : `${host}/${name}`;
}
