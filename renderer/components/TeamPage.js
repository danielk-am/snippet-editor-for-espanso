import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { api } from '../lib/api.js';
import { Alert, Badge, Button, ConfirmDialog, Empty, useToast } from '../lib/ui.js';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const when = (iso) => {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

function PackageCard({ pkg, busy, onInstall, onRemove }) {
	const action = !pkg.installed ? 'Install' : pkg.updateAvailable ? 'Update' : null;
	const facts = [
		pkg.matchCount === null ? 'not read' : `${plural(pkg.matchCount, 'snippet')} in ${plural(pkg.files.length, 'file')}`,
		pkg.version && `version ${pkg.version}`,
		pkg.author && `by ${pkg.author}`,
	].filter(Boolean);
	const notes = [pkg.manifestError, ...pkg.problems].filter(Boolean);

	return html`<article class="team-card">
		<div class="team-card__head">
			<h2 class="truncate">${pkg.title}</h2>
			<div class="team-card__badges">
				${pkg.installed && html`<${Badge} tone="success" icon="check">Installed<//>`}
				${pkg.updateAvailable && html`<${Badge} tone="accent" icon="refresh">Update available<//>`}
				${pkg.runsCommands && html`<${Badge} tone="danger" icon="prompt">Runs commands<//>`}
			</div>
		</div>
		${pkg.description && html`<p class="team-card__desc">${pkg.description}</p>`}
		<p class="team-card__meta"><code>${pkg.name}</code> ${facts.join(', ')}</p>
		${notes.length > 0 && html`<ul class="team-card__notes">${notes.map((note) => html`<li>${note}</li>`)}</ul>`}
		<div class="team-card__actions">
			${action &&
			html`<${Button} icon=${action === 'Install' ? 'download' : 'refresh'} disabled=${busy || pkg.matchCount === null} onClick=${() => onInstall(pkg)}>${action}<//>`}
			${pkg.installed && html`<${Button} variant="outline" disabled=${busy} onClick=${() => onRemove(pkg)}>Remove<//>`}
		</div>
	</article>`;
}

// Everything the connected repository offers, and what to do with each
// package: install it, update it, or remove it.
export function TeamPage({ navigate, refresh }) {
	const toast = useToast();
	const [team, setTeam] = useState(null);
	const [loadError, setLoadError] = useState('');
	const [busy, setBusy] = useState(false);
	const [asking, setAsking] = useState(null);
	// Checked at once, where `busy` only changes on the next draw.
	const working = useRef(false);

	const load = () =>
		api.team().then(
			(next) => {
				setTeam(next);
				setLoadError('');
			},
			(failure) => setLoadError(failure.message)
		);
	useEffect(() => {
		load();
	}, []);

	const run = async (work, done) => {
		if (working.current) return;
		working.current = true;
		setBusy(true);
		try {
			setTeam(await work());
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

	const install = (pkg, acceptCommands) =>
		run(() => api.installTeamPackage(pkg.name, { acceptCommands }), `${pkg.title} ${pkg.installed ? 'updated' : 'installed'}`);
	const onInstall = (pkg) => (pkg.runsCommands ? setAsking({ about: 'commands', pkg }) : install(pkg));
	const remove = (name, title) => run(() => api.removeTeamPackage(name), `${title} removed`);

	if (!team) {
		return html`<div class="page">
			${loadError ? html`<${Alert} tone="danger" icon="alert" title="Team packages could not be read"><p>${loadError}</p><//>` : html`<p class="muted" role="status">Loading team packages…</p>`}
		</div>`;
	}

	const leftovers =
		team.installedOnly.length > 0 &&
		html`<h2 class="section-title">${team.connected ? 'Installed, but no longer in the repository' : 'Still installed'} (${team.installedOnly.length})</h2>
			<ul class="team-leftovers">
				${team.installedOnly.map(
					(item) =>
						html`<li>
							<code>${item.name}</code>
							<${Button} variant="outline" size="sm" disabled=${busy} onClick=${() => setAsking({ about: 'remove', pkg: { name: item.name, title: item.name } })}>Remove<//>
						</li>`
				)}
			</ul>`;

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
						install(asking.pkg, true);
					}}
				/>`
			: asking?.about === 'remove'
				? html`<${ConfirmDialog}
						title=${`Remove ${asking.pkg.title}?`}
						description="Its snippets stop working in Espanso. You can install it again while the repository still has it."
						confirmLabel="Remove"
						destructive
						onClose=${() => setAsking(null)}
						onConfirm=${() => {
							setAsking(null);
							remove(asking.pkg.name, asking.pkg.title);
						}}
					/>`
				: null;

	if (!team.connected) {
		return html`<div class="page">
			<div class="page-head">
				<div class="page-head__text">
					<h1>Team packages</h1>
					<p>Snippets your team shares from one GitHub repository.</p>
				</div>
			</div>
			${team.problem && html`<${Alert} tone="warning" icon="alert" title=${team.problem} />`}
			<${Empty} icon="team" title="No team repository is connected" actions=${html`<${Button} icon="settings" onClick=${() => navigate({ view: 'settings' })}>Open Settings<//>`}>
				Connect your team's repository in Settings to browse and install its packages.
			<//>
			${leftovers} ${dialog}
		</div>`;
	}

	return html`<div class="page">
		<div class="page-head">
			<div class="page-head__text">
				<h1>Team packages</h1>
				<p>From <code>${team.repository}</code>${team.fetchedAt && `, last checked ${when(team.fetchedAt)}`}</p>
			</div>
			<div class="page-head__actions">
				<${Button} variant="outline" icon="refresh" disabled=${busy} onClick=${() => run(api.refreshTeam, 'Checked for updates')}>Check for updates<//>
			</div>
		</div>
		${team.problem &&
		html`<${Alert} tone="warning" icon="alert" title="The repository could not be reached">
			<p>${team.problem} What is listed here is from the last time it could.</p>
		<//>`}
		${team.problems.length > 0 && html`<${Alert} icon="info" title="Some of the repository is not shown"><ul>${team.problems.map((note) => html`<li>${note}</li>`)}</ul><//>`}
		${!team.packages.length &&
		!team.problems.length &&
		html`<${Empty} icon="package" title="No packages yet">A package is a folder under packages/ in the repository, with a _manifest.yml and its match files.<//>`}
		<div class="team-list">
			${team.packages.map(
				(pkg) =>
					html`<${PackageCard}
						key=${pkg.name}
						pkg=${pkg}
						busy=${busy}
						onInstall=${onInstall}
						onRemove=${(item) => setAsking({ about: 'remove', pkg: item })}
					/>`
			)}
		</div>
		${leftovers} ${dialog}
	</div>`;
}
