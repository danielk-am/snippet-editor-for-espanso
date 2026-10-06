import { html, useEffect, useState } from '../vendor/preact-htm.js';
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

export function SettingsPage({ state, theme, setTheme, refresh }) {
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
			<${ApiCard} />
			<${Card} title="Appearance">
				<${Segmented} label="Theme" options=${THEMES} value=${theme} onChange=${setTheme} />
			<//>
		</div>
	</div>`;
}
