import { html } from '../vendor/preact-htm.js';
import { api, allFiles } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { Alert, Badge, Button, Card, useToast } from '../lib/ui.js';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function Overview({ state, navigate, onNewFile, onNewSnippet, snippetCount }) {
	const toast = useToast();
	const localSnippets = state.files.reduce((sum, file) => sum + (file.matchCount ?? 0), 0);
	const broken = allFiles(state).filter((file) => file.matches === null);

	const steps = [
		{ label: 'Match folder', done: state.exists && !state.error, state: state.error ? 'Not readable' : state.exists ? 'Found' : 'Not found' },
		{ label: 'First file', done: state.files.length > 0, state: state.files.length ? plural(state.files.length, 'file') : 'To do' },
		{ label: 'First snippet', done: localSnippets > 0, state: localSnippets ? `${localSnippets} in your files` : 'To do' },
	];
	const current = steps.findIndex((step) => !step.done);

	const reveal = () => api.reveal('matchDir').catch((failure) => toast({ tone: 'error', title: 'Could not open the folder', description: failure.message }));

	const stat = (label, value, alert) => html`<div class=${alert ? 'card stat stat--alert' : 'card stat'}>
		<div class="stat__label">${label}</div>
		<div class="stat__value">${value}</div>
	</div>`;

	return html`<div class="page">
		<div class="page-head">
			<div class="page-head__text">
				<h1>Overview</h1>
				<p>Your Espanso snippets, read straight from the match folder.</p>
			</div>
			<div class="page-head__actions">
				<${Button} variant="outline" icon="file" onClick=${onNewFile}>New file<//>
				<${Button} icon="plus" onClick=${() => onNewSnippet()}>New snippet<//>
			</div>
		</div>

		<div class="stack">
			${!state.exists &&
			html`<${Alert}
				tone="warning"
				icon="alert"
				title="Nothing exists at the match folder yet"
				actions=${html`
					<${Button} size="sm" icon="plus" onClick=${onNewFile}>Create the first file<//>
					<${Button} size="sm" variant="outline" onClick=${() => navigate({ view: 'settings' })}>Choose another folder<//>
				`}
			>
				<p>Creating your first file also creates the folder. If Espanso keeps its files somewhere else, choose that folder instead.</p>
			<//>`}
			${state.error &&
			html`<${Alert}
				tone="danger"
				icon="alert"
				title="The match folder could not be read"
				actions=${html`<${Button} size="sm" variant="outline" onClick=${() => navigate({ view: 'settings' })}>Choose another folder<//>`}
			>
				<p>${state.error}</p>
			<//>`}
			${broken.map((file) =>
				file.unreadable
					? html`<${Alert} tone="danger" icon="alert" title=${`${file.name} could not be opened`}><p>${file.parseErrors[0]}</p><//>`
					: html`<${Alert}
							tone="danger"
							icon="alert"
							title=${`${file.name} has YAML errors`}
							actions=${html`<${Button} size="sm" variant="outline" icon="code" onClick=${() => navigate({ view: 'file', fileId: file.id, tab: 'raw' })}>Open the raw editor<//>`}
						>
							<p>Espanso skips this file until it is fixed. ${file.parseErrors[0]}</p>
						<//>`
			)}

			<div class="stats">
				${stat('Snippets', snippetCount)} ${stat('Local files', state.files.length)} ${stat('Packages', state.packages.length)}
				${stat('Files with errors', broken.length, broken.length > 0)}
			</div>

			<section class="card" aria-label="Getting started">
				<ol class="journey">
					${steps.map(
						(step, index) => html`
							${index > 0 && html`<${Icon} name="chevron-right" />`}
							<li class="journey__step" aria-current=${index === current ? 'step' : undefined}>
								<span class="journey__ordinal">${String(index + 1).padStart(2, '0')}</span>
								<span class="journey__label">${step.label}</span>
								<${Badge} tone=${step.done ? 'success' : index === current ? 'accent' : undefined} icon=${step.done ? 'check' : undefined}>${step.state}<//>
							</li>
						`
					)}
				</ol>
			</section>

			${state.files.length > 0 &&
			html`<section aria-label="Your files">
				<ul class="file-list">
					${state.files.map(
						(file) =>
							html`<li>
								<button class="file-row" onClick=${() => navigate({ view: 'file', fileId: file.id })}>
									<span class="file-row__name"><${Icon} name="file" /><span class="truncate">${file.name}</span></span>
									<span class="muted truncate">${file.description || (file.importOnly ? 'Loaded only when another file imports it' : '')}</span>
									${file.matches === null ? html`<${Badge} tone="danger" icon="alert">${file.unreadable ? 'Not opened' : 'YAML errors'}<//>` : html`<${Badge}>${plural(file.matchCount, 'snippet')}<//>`}
								</button>
							</li>`
					)}
				</ul>
			</section>`}

			<section class="card context-strip" aria-label="Match folder">
				<div class="context-strip__text">
					<div class="context-strip__eyebrow">Match folder</div>
					<div class="context-strip__path">${state.matchDir}</div>
				</div>
				<div class="context-strip__actions">
					${state.exists && html`<${Button} variant="outline" size="sm" icon="folder" onClick=${reveal}>Open folder<//>`}
					<${Button} variant="outline" size="sm" icon="settings" onClick=${() => navigate({ view: 'settings' })}>Settings<//>
				</div>
			</section>
		</div>
	</div>`;
}
