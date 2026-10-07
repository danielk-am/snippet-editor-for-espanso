import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { repositoryLabel } from '../../shared/repositoryLabel.js';
import { api } from '../lib/api.js';
import { Alert, Badge, Button, ConfirmDialog, Empty, useId, useToast } from '../lib/ui.js';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const when = (iso) => {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

// What the question before a removal says, by where the package is listed.
const AFTER_REMOVAL = {
	offered: 'You can install it again while the repository still has it.',
	dropped: 'Its repository no longer has it, so it cannot be installed again from there.',
	apart: 'To install it again, connect the repository it came from.',
};

function PackageCard({ pkg, busy, onInstall, onRemove }) {
	const heldId = useId('held');
	// A name is installed from one repository at a time. When another one
	// holds this name, this package cannot be installed until that one is removed.
	const heldBy = pkg.installedFrom ? repositoryLabel(pkg.installedFrom) : '';
	const action = !pkg.installed ? 'Install' : pkg.updateAvailable ? 'Update' : null;
	const facts = [
		pkg.matchCount === null ? 'not read' : `${plural(pkg.matchCount, 'snippet')} in ${plural(pkg.files.length, 'file')}`,
		pkg.version && `version ${pkg.version}`,
		pkg.author && `by ${pkg.author}`,
	].filter(Boolean);
	const notes = [pkg.manifestError, ...pkg.problems].filter(Boolean);

	return html`<article class="team-card">
		<div class="team-card__head">
			<h3 class="truncate">${pkg.title}</h3>
			<div class="team-card__badges">
				${pkg.installed && html`<${Badge} tone="success" icon="check">Installed<//>`}
				${pkg.updateAvailable && html`<${Badge} tone="accent" icon="refresh">Update available<//>`}
				${pkg.runsCommands && html`<${Badge} tone="danger" icon="prompt">Runs commands<//>`}
			</div>
		</div>
		${pkg.description && html`<p class="team-card__desc">${pkg.description}</p>`}
		<p class="team-card__meta"><code>${pkg.name}</code> ${facts.join(', ')}</p>
		${notes.length > 0 && html`<ul class="team-card__notes">${notes.map((note) => html`<li>${note}</li>`)}</ul>`}
		${heldBy && html`<p class="team-card__held" id=${heldId}>Installed from <strong>${heldBy}</strong>. Remove it first, then install this one.</p>`}
		<div class="team-card__actions">
			${action &&
			html`<${Button}
				icon=${action === 'Install' ? 'download' : 'refresh'}
				disabled=${busy || pkg.matchCount === null || Boolean(heldBy)}
				aria-describedby=${heldBy ? heldId : undefined}
				onClick=${() => onInstall(pkg)}
			>
				${action}
			<//>`}
			${pkg.installed && html`<${Button} variant="outline" disabled=${busy} onClick=${() => onRemove(pkg)}>Remove<//>`}
		</div>
	</article>`;
}

// Everything the connected repositories offer, a section for each, and what
// to do with each package: install it, update it, or remove it. Under the
// sections, the installed packages that are no longer on offer.
export function TeamPage({ state, navigate, refresh }) {
	const toast = useToast();
	// The app's team status: every connected repository.
	const [team, setTeam] = useState(null);
	const [loadError, setLoadError] = useState('');
	const [busy, setBusy] = useState(false);
	const [asking, setAsking] = useState(null);
	// Checked at once, where `busy` only changes on the next draw.
	const working = useRef(false);
	// Counts what has been shown, so an answer that was overtaken is dropped.
	const latest = useRef(0);

	const load = () => {
		const mine = (latest.current += 1);
		return api.team().then(
			(next) => {
				if (mine !== latest.current) return;
				setTeam(next);
				setLoadError('');
			},
			(failure) => mine === latest.current && setLoadError(failure.message)
		);
	};
	// Read when the page opens, and again whenever the app's picture of the
	// folder changes. That is after every action of this page, and also when
	// something else finishes while it is open: a repository connected or
	// disconnected in Settings, one fetched at start, a card the assistant applied.
	useEffect(() => {
		load();
	}, [state]);

	const run = async (work, done) => {
		if (working.current) return;
		working.current = true;
		setBusy(true);
		try {
			const next = await work();
			latest.current += 1;
			setTeam(next);
			// The sidebar and search read the folder, which has just changed.
			await refresh();
			toast({ title: done });
		} catch (failure) {
			toast({ tone: 'error', title: 'That did not work', description: failure.message });
			await load();
		} finally {
			working.current = false;
			setBusy(false);
		}
	};

	// A package is installed from the repository whose section it is in.
	const install = (repository, pkg, acceptCommands) =>
		run(() => api.installTeamPackage(pkg.name, { repository: repository.id, acceptCommands }), `${pkg.title} ${pkg.installed ? 'updated' : 'installed'}`);
	const onInstall = (repository, pkg) => (pkg.runsCommands ? setAsking({ about: 'commands', repository, pkg }) : install(repository, pkg));
	// A name is installed once, so removing needs no repository.
	const remove = (name, title) => run(() => api.removeTeamPackage(name), `${title} removed`);

	if (!team) {
		return html`<div class="page">
			${loadError ? html`<${Alert} tone="danger" icon="alert" title="Team packages could not be read"><p>${loadError}</p><//>` : html`<p class="muted" role="status">Loading team packages…</p>`}
		</div>`;
	}

	const section = (repository) => {
		const headingId = `team-repo-${repository.id}`;
		return html`<section class="team-repo" key=${repository.id} aria-labelledby=${headingId}>
			<div class="team-repo__head">
				<div class="team-repo__text">
					<h2 class="section-title" id=${headingId}>${repositoryLabel(repository.repository)}</h2>
					<p class="field__help">From <code>${repository.repository}</code>${repository.fetchedAt && `, last checked ${when(repository.fetchedAt)}`}</p>
				</div>
				<${Button} variant="outline" icon="refresh" disabled=${busy} aria-describedby=${headingId} onClick=${() => run(() => api.refreshTeam(repository.id), 'Checked for updates')}>
					Check for updates
				<//>
			</div>
			${repository.problem &&
			html`<${Alert} tone="warning" icon="alert" title="The repository could not be reached">
				<p>${repository.problem} What is listed here is from the last time it could.</p>
			<//>`}
			${repository.problems.length > 0 &&
			html`<${Alert} icon="info" title="Some of the repository is not shown"><ul>${repository.problems.map((note) => html`<li>${note}</li>`)}</ul><//>`}
			${!repository.packages.length &&
			!repository.problems.length &&
			html`<${Empty} icon="package" title="No packages yet">A package is a folder under packages/ in the repository, with a _manifest.yml and its match files.<//>`}
			${repository.packages.length > 0 &&
			html`<div class="team-list">
				${repository.packages.map(
					(pkg) =>
						html`<${PackageCard}
							key=${pkg.name}
							pkg=${pkg}
							busy=${busy}
							onInstall=${(item) => onInstall(repository, item)}
							onRemove=${(item) => setAsking({ about: 'remove', pkg: item, after: AFTER_REMOVAL.offered })}
						/>`
				)}
			</div>`}
		</section>`;
	};

	// Installed packages that are on offer nowhere, in two lists. `from` says
	// where each came from: a connected repository by the name its section
	// has, one that is not connected by its address.
	const dropped = team.repositories.flatMap((repository) => repository.installedOnly.map((item) => ({ name: item.name, from: repositoryLabel(repository.repository) })));
	// A marker that cannot be read names no repository.
	const apart = team.installedOnly.map((item) => ({ name: item.name, from: item.repository || 'Its repository is not recorded' }));
	const left = (title, items, after) =>
		items.length > 0 &&
		html`<section class="team-left">
			<h2 class="section-title">${title} (${items.length})</h2>
			<ul class="team-leftovers">
				${items.map(
					(item) =>
						html`<li key=${item.name}>
							<span class="team-leftovers__what"><code>${item.name}</code><span class="team-leftovers__from">${item.from}</span></span>
							<${Button} variant="outline" size="sm" disabled=${busy} onClick=${() => setAsking({ about: 'remove', pkg: { name: item.name, title: item.name }, after })}>Remove<//>
						</li>`
				)}
			</ul>
		</section>`;

	const dialog =
		asking?.about === 'commands'
			? html`<${ConfirmDialog}
					title="This package runs commands"
					description=${`Some snippets in ${asking.pkg.title} run shell commands or scripts on your computer when you use them. ${asking.pkg.installed ? 'Update' : 'Install'} it only if you trust everyone who can change this repository.`}
					confirmLabel=${asking.pkg.installed ? 'Update anyway' : 'Install anyway'}
					destructive
					onClose=${() => setAsking(null)}
					onConfirm=${() => {
						setAsking(null);
						install(asking.repository, asking.pkg, true);
					}}
				/>`
			: asking?.about === 'remove'
				? html`<${ConfirmDialog}
						title=${`Remove ${asking.pkg.title}?`}
						description=${`Its snippets stop working in Espanso. ${asking.after}`}
						confirmLabel="Remove"
						destructive
						onClose=${() => setAsking(null)}
						onConfirm=${() => {
							setAsking(null);
							remove(asking.pkg.name, asking.pkg.title);
						}}
					/>`
				: null;

	return html`<div class="page">
		<div class="page-head">
			<div class="page-head__text">
				<h1>Team packages</h1>
				<p>Snippets your team shares from GitHub repositories.</p>
			</div>
		</div>
		<div class="team-sections">
			${team.problem && html`<${Alert} tone="warning" icon="alert" title=${team.problem} />`}
			${!team.repositories.length &&
			html`<${Empty} icon="team" title="No team repository is connected" actions=${html`<${Button} icon="settings" onClick=${() => navigate({ view: 'settings' })}>Open Settings<//>`}>
				Connect your team's repository in Settings to browse and install its packages.
			<//>`}
			${team.repositories.map(section)}
			${left('Installed, but no longer in the repository', dropped, AFTER_REMOVAL.dropped)}
			${left('From repositories that are not connected', apart, AFTER_REMOVAL.apart)}
		</div>
		${dialog}
	</div>`;
}
