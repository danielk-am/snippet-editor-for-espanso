// How a team repository is named for a person: its owner and name, as in
// "acme/team-snippets". Every message, card and page that names a repository
// gets the name here, so that they all say the same thing.
//
// It is given the address as the app keeps it, which is what
// core/teamAddress.js made of what was typed: one of the three forms below,
// always ending in ".git". A folder, which only a test connects, has no
// owner, so its path stands in for the name. So does any other text that is
// none of the three: nothing is guessed from it.
//
// This file loads nothing else, so the window can use it as well as the app.

const NAME = '[A-Za-z0-9][A-Za-z0-9._-]*';
// https://host/owner/repo.git, git@host:owner/repo.git and
// ssh://git@host/owner/repo.git. A host may carry a port, and never a sign-in.
const KEPT = new RegExp(`^(?:https://[^/@\\s]+/|git@[^/:@\\s]+:|ssh://git@[^/@\\s]+/)(${NAME})/(${NAME})\\.git$`);

export function repositoryLabel(url) {
	if (typeof url !== 'string') return '';
	const kept = KEPT.exec(url);
	return kept ? `${kept[1]}/${kept[2]}` : url;
}
