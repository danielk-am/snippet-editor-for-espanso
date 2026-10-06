import { html } from '../vendor/preact-htm.js';
import { api, platform } from '../lib/api.js';
import { Button, Card, IconButton, Segmented, useToast } from '../lib/ui.js';

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

function PathRow({ path }) {
	const toast = useToast();
	return html`<div class="copy-row">
		<code>${path}</code>
		<${IconButton}
			label="Copy path"
			icon="copy"
			size="sm"
			onClick=${async () => {
				await api.copy(path);
				toast({ title: 'Path copied' });
			}}
		/>
	</div>`;
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
			<${Card} title="Appearance">
				<${Segmented} label="Theme" options=${THEMES} value=${theme} onChange=${setTheme} />
			<//>
		</div>
	</div>`;
}
