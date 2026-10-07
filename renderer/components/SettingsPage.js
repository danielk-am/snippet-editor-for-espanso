import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { repositoryLabel } from '../../shared/repositoryLabel.js';
import { MAX_TEAM_REPOSITORIES } from '../../shared/teamLimits.js';
import { api, platform } from '../lib/api.js';
import { Alert, Button, Card, ConfirmDialog, Field, IconButton, Segmented, Switch, useToast } from '../lib/ui.js';

const SOURCES = {
	default: 'This is where Espanso keeps its match files on this computer.',
	legacy: "This is Espanso's older config location, which exists on this computer.",
	env: 'Set by an environment variable (SNIPPET_EDITOR_MATCH_DIR or ESPANSO_CONFIG_DIR).',
	settings: 'You chose this folder.',
};

const THEMES = [
	{ id: 'system', label: 'Match system', icon: 'monitor' },
	{ id: 'light', label: 'Light', icon: 'sun' },
	{ id: 'dark', label: 'Dark', icon: 'moon' },
];

const fileManager = platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'Explorer' : 'the file manager';

function PathRow({ path, what = 'Path' }) {
	const toast = useToast();
	return html`<div class="copy-row">
		<code>${path}</code>
		<${IconButton}
			label=${`Copy ${what.toLowerCase()}`}
			icon="copy"
			size="sm"
			onClick=${async () => {
				await api.copy(path);
				toast({ title: `${what} copied` });
			}}
		/>
	</div>`;
}

// The HTTP door for other tools. The window never needs it, so it is off
// until someone switches it on. The token is copied by the main process and
// is never shown here.
function ApiCard() {
	const toast = useToast();
	const [status, setStatus] = useState(null);
	const [port, setPort] = useState('');
	const [confirmReplace, setConfirmReplace] = useState(false);

	const show = (next) => {
		setStatus(next);
		setPort(String(next.port));
	};
	useEffect(() => {
		api.listener().then(show, () => {});
	}, []);

	const attempt = async (work, done) => {
		try {
			const result = await work();
			if (result && typeof result === 'object') show(result);
			if (done) toast({ title: done });
		} catch (failure) {
			toast({ tone: 'error', title: 'That did not work', description: failure.message });
		}
	};

	if (!status) return null;
	const wanted = /^\d+$/.test(port.trim()) ? Number(port) : NaN;
	const portError = wanted >= 1024 && wanted <= 65535 ? '' : 'Use a whole number from 1024 to 65535.';
	const summary = !status.enabled ? 'Off. The window does not need it.' : status.running ? 'On. Other tools can reach it at the address below.' : 'On, but not running.';

	return html`<${Card}
		title="API for other tools"
		description="Lets scripts and other apps on this computer read and change your snippets. It answers this computer only, never other computers or web pages."
	>
		<div class="setting">
			<${Switch}
				title="Let other tools use the API"
				description=${summary}
				checked=${status.enabled}
				onChange=${(enabled) => attempt(() => api.setListener({ enabled, port: status.port }))}
			/>
			${status.enabled &&
			!status.running &&
			html`<${Alert}
				tone="warning"
				icon="alert"
				title=${status.problem}
				actions=${html`<${Button} variant="outline" size="sm" icon="refresh" onClick=${() => attempt(() => api.setListener({ enabled: true, port: status.port }))}>Try again<//>`}
			/>`}
			${status.running && html`<${PathRow} path=${status.address} what="Address" />`}
			${status.enabled &&
			html`
				<${Field} label="Port" error=${portError}>
					${(control) =>
						html`<div class="setting__port">
							<input class="input mono" type="text" inputmode="numeric" value=${port} onInput=${(event) => setPort(event.target.value)} ...${control} />
							<${Button} variant="outline" disabled=${Boolean(portError) || wanted === status.port} onClick=${() => attempt(() => api.setListener({ enabled: true, port: wanted }))}>
								Use this port
							<//>
						</div>`}
				<//>
				<div class="setting__actions">
					<${Button} variant="outline" icon="copy" onClick=${() => attempt(() => api.copyFromListener('token'), 'Token copied')}>Copy token<//>
					<${Button} variant="outline" icon="copy" onClick=${() => attempt(() => api.copyFromListener('curl'), 'Example copied')}>Copy a curl example<//>
					<${Button} variant="ghost" onClick=${() => setConfirmReplace(true)}>Replace token<//>
				</div>
				<p class="field__help">
					Send the token with every request as an <code>Authorization: Bearer</code> header. Anyone who has it can change your snippets, so treat it
					like a password.
				</p>
			`}
		</div>
		${confirmReplace &&
		html`<${ConfirmDialog}
			title="Replace the token?"
			description="Anything using the current token stops working until you give it the new one."
			confirmLabel="Replace token"
			onClose=${() => setConfirmReplace(false)}
			onConfirm=${() => {
				setConfirmReplace(false);
				attempt(() => api.replaceToken(), 'Token replaced');
			}}
		/>`}
	<//>`;
}

// What an AI tool may do through the MCP server that comes with the app.
function AiCard() {
	const toast = useToast();
	const [ai, setAi] = useState(null);
	const [format, setFormat] = useState('json');
	useEffect(() => {
		api.ai().then(setAi, () => {});
	}, []);
	if (!ai) return null;
	const setup = format === 'toml' ? ai.setupToml : ai.setup;

	const change = async (write) => {
		try {
			setAi(await api.setAi({ write }));
		} catch (failure) {
			toast({ tone: 'error', title: 'That did not work', description: failure.message });
		}
	};

	return html`<${Card}
		title="AI tools"
		description="An AI tool such as Claude or Codex can search and read your snippets through the MCP server that comes with this app. The app must be open, with the API above switched on."
	>
		<div class="setting">
			<${Switch}
				title="Let AI tools change snippets"
				description=${ai.write
					? 'On. AI tools can add, change and delete snippets, install team packages and send proposals. Every change needs the version of the file it read, and keeps a backup. A snippet can run a command on your computer: an AI tool must say you agreed before it writes one, so read what it asks you to approve.'
					: 'Off. AI tools can search and read, and nothing else.'}
				checked=${ai.write}
				onChange=${change}
			/>
			${ai.setup &&
			html`
				<p class="field__help">To connect an AI tool, add this to its MCP settings. It holds paths only, no password or token.</p>
				${ai.warning && html`<${Alert} tone="warning" icon="alert" title=${ai.warning} />`}
				<${Segmented}
					label="Format of the setup"
					options=${[
						{ id: 'json', label: 'JSON, for Claude and most tools' },
						{ id: 'toml', label: 'TOML, for Codex' },
					]}
					value=${format}
					onChange=${setFormat}
				/>
				<pre class="code-block" tabindex="0" aria-label="MCP setup">${setup}</pre>
				<div class="setting__actions">
					<${Button}
						variant="outline"
						icon="copy"
						onClick=${async () => {
							await api.copy(setup);
							toast({ title: 'Setup copied' });
						}}
					>
						Copy setup
					<//>
				</div>
			`}
			<p class="field__help">This switch governs AI tools that use this MCP server. Another program that holds the API token can still change snippets through the API.</p>
		</div>
	<//>`;
}

// Which GitHub repositories the team's shared snippets come from. Connecting
// is a setting, so it lives here; browsing and installing is on its own page.
function TeamCard({ state, navigate, refresh }) {
	const toast = useToast();
	// The app's team status: every connected repository.
	const [team, setTeam] = useState(null);
	const [address, setAddress] = useState('');
	// What went wrong, and where to say it: under the field ('connect'), or
	// on one repository (its id).
	const [error, setError] = useState(null);
	// What is under way, and for which repository.
	const [busy, setBusy] = useState(null);
	// The repository the question "Disconnect?" is about.
	const [leaving, setLeaving] = useState(null);
	const working = useRef(false);
	// Counts what has been shown, so an answer that was overtaken is dropped.
	const latest = useRef(0);
	const here = useRef(true);
	useEffect(() => () => (here.current = false), []);

	// Read when the card opens, and again whenever the app's picture of the
	// folder changes: a repository fetched at start, or one that finished
	// connecting after this page was left and opened again.
	useEffect(() => {
		const mine = (latest.current += 1);
		api.team().then(
			(status) => mine === latest.current && setTeam(status),
			() => {}
		);
	}, [state]);

	const act = async (what, id, work, done) => {
		if (working.current) return;
		working.current = true;
		setBusy({ what, id });
		setError(null);
		try {
			const status = await work();
			latest.current += 1;
			setTeam(status);
			await refresh();
			if (done) toast({ title: done });
		} catch (failure) {
			// The work goes on when this page is left. If it fails then, the
			// reason is still said, where it can be seen.
			if (here.current) setError({ at: id ?? 'connect', message: failure.message });
			else toast({ tone: 'error', title: 'That did not work', description: failure.message });
		} finally {
			working.current = false;
			setBusy(null);
		}
	};

	if (!team) return null;
	const connected = team.repositories;
	const doing = (what, id) => busy?.what === what && busy.id === id;

	const connect = (event) => {
		event.preventDefault();
		if (!address.trim()) return setError({ at: 'connect', message: 'Enter the address of the repository.' });
		act(
			'connect',
			null,
			async () => {
				const status = await api.connectTeam(address);
				setAddress('');
				return status;
			},
			'Team repository connected'
		);
	};

	const repository = (item) => {
		const checked = item.fetchedAt ? new Date(item.fetchedAt).toLocaleString() : '';
		return html`<li key=${item.id}>
			<div class="setting" role="group" aria-label=${repositoryLabel(item.repository)}>
				<${PathRow} path=${item.repository} what="Address" />
				<p class="field__help">${item.branch ? `Branch ${item.branch}.` : 'Not copied yet.'} ${checked && `Last checked ${checked}.`}</p>
				${item.problem && html`<${Alert} tone="warning" icon="alert" title="The repository could not be reached"><p>${item.problem}</p><//>`}
				${error?.at === item.id && html`<${Alert} tone="danger" icon="alert" title=${error.message} />`}
				<div class="setting__actions">
					<${Button} variant="outline" icon="refresh" disabled=${Boolean(busy)} onClick=${() => act('check', item.id, () => api.refreshTeam(item.id), 'Checked for updates')}>
						${doing('check', item.id) ? 'Checking…' : 'Check for updates'}
					<//>
					<${Button} variant="ghost" disabled=${Boolean(busy)} onClick=${() => setLeaving(item)}>${doing('disconnect', item.id) ? 'Disconnecting…' : 'Disconnect'}<//>
				</div>
			</div>
		</li>`;
	};

	const description = !connected.length
		? 'Connect the GitHub repository your team keeps its shared snippets in. The app uses the git sign-in this computer already has, and saves no password or token.'
		: `Packages from ${connected.length === 1 ? 'this repository' : 'these repositories'} are installed on the Team packages page. Nothing is installed or updated without you asking.`;

	return html`<${Card}
		title="Team snippets"
		description=${description}
		actions=${connected.length > 0 && html`<${Button} variant="outline" size="sm" icon="team" onClick=${() => navigate({ view: 'team' })}>Browse team packages<//>`}
	>
		<div class="setting">
			${team.problem && html`<${Alert} tone="warning" icon="alert" title=${team.problem} />`}
			${connected.length > 0 && html`<ul class="team-repos" aria-label="Connected repositories">${connected.map(repository)}</ul>`}
			${connected.length < MAX_TEAM_REPOSITORIES
				? html`<form class="setting" onSubmit=${connect}>
						<${Field}
							label=${connected.length ? 'Connect another repository' : 'Repository address'}
							help="For example acme/team-snippets, or git@github.com:acme/team-snippets.git."
							error=${error?.at === 'connect' ? error.message : ''}
						>
							${(control) =>
								html`<div class="setting__team">
									<input class="input mono" value=${address} onInput=${(event) => setAddress(event.target.value)} spellcheck="false" ...${control} />
									<${Button} type="submit" disabled=${Boolean(busy)}>${doing('connect', null) ? 'Connecting…' : 'Connect'}<//>
								</div>`}
						<//>
					</form>`
				: html`<p class="field__help">Ten repositories are connected, which is the most. Disconnect one to connect another.</p>`}
			${!connected.length &&
			team.installedOnly.length > 0 &&
			html`<p class="field__help">
				${team.installedOnly.length === 1 ? '1 team package is' : `${team.installedOnly.length} team packages are`} still installed.${' '}
				<button type="button" class="link" onClick=${() => navigate({ view: 'team' })}>Manage them</button>
			</p>`}
		</div>
		${leaving &&
		html`<${ConfirmDialog}
			title=${`Disconnect ${repositoryLabel(leaving.repository)}?`}
			description="The app forgets this repository and removes its copy of it. Team packages you installed from it stay until you remove them."
			confirmLabel="Disconnect"
			onClose=${() => setLeaving(null)}
			onConfirm=${() => {
				const { id } = leaving;
				setLeaving(null);
				act('disconnect', id, () => api.disconnectTeam(id), 'Repository disconnected');
			}}
		/>`}
	<//>`;
}

export function SettingsPage({ state, theme, setTheme, refresh, navigate }) {
	const toast = useToast();
	const attempt = async (work) => {
		try {
			const result = await work();
			if (result?.changed) await refresh();
		} catch (failure) {
			toast({ tone: 'error', title: 'That did not work', description: failure.message });
		}
	};

	return html`<div class="page">
		<div class="page-head">
			<div class="page-head__text">
				<h1>Settings</h1>
				<p>Where your snippets live and how the app looks.</p>
			</div>
		</div>
		<div class="stack">
			<${Card} title="Match folder" description=${SOURCES[state.matchDirSource]}>
				<div class="setting">
					<${PathRow} path=${state.matchDir} />
					${!state.exists && html`<p class="field__help">This folder does not exist yet. Creating your first file creates it.</p>`}
					<div class="setting__actions">
						<${Button} variant="outline" icon="folder" onClick=${() => attempt(api.chooseMatchDir)}>Choose folder…<//>
						${state.matchDirSource === 'settings' && html`<${Button} variant="outline" onClick=${() => attempt(api.resetMatchDir)}>Use Espanso's default<//>`}
						${state.exists && html`<${Button} variant="ghost" onClick=${() => attempt(() => api.reveal('matchDir'))}>Show in ${fileManager}<//>`}
					</div>
				</div>
			<//>
			<${Card} title="Backups" description=${`Before each save or delete, the app keeps a copy of the file as it was. The newest ${state.maxBackups} copies of each file are kept.`}>
				<div class="setting">
					<${PathRow} path=${state.backupDir} />
					<div class="setting__actions">
						<${Button} variant="outline" icon="folder" onClick=${() => attempt(() => api.reveal('backups'))}>Show in ${fileManager}<//>
					</div>
				</div>
			<//>
			<${TeamCard} state=${state} navigate=${navigate} refresh=${refresh} />
			<${ApiCard} />
			<${AiCard} />
			<${Card} title="Appearance">
				<${Segmented} label="Theme" options=${THEMES} value=${theme} onChange=${setTheme} />
			<//>
		</div>
	</div>`;
}
