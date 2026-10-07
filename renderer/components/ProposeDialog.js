import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { api, oneRepository } from '../lib/api.js';
import { Alert, Button, Dialog, Field, Select } from '../lib/ui.js';

const NEW = '+new';

// Sends one of your own files to a team package as a new branch. The team
// decides what happens to it: the app only ever pushes that branch.
export function ProposeDialog({ file, onClose, navigate }) {
	const [team, setTeam] = useState(null);
	const [target, setTarget] = useState(NEW);
	const [name, setName] = useState('');
	const [title, setTitle] = useState('');
	const [description, setDescription] = useState('');
	const [summary, setSummary] = useState('');
	const [error, setError] = useState('');
	const [sending, setSending] = useState(false);
	const [sent, setSent] = useState(null);
	// Checked at once, so a second click in the same instant sends nothing.
	const busy = useRef(false);

	useEffect(() => {
		// This dialog proposes to one repository: see `oneRepository`.
		api.team().then(
			(status) => {
				const next = oneRepository(status);
				setTeam(next);
				setTarget(next.packages[0]?.name ?? NEW);
			},
			(failure) => setError(failure.message)
		);
	}, []);

	const isNew = target === NEW;

	const send = async (event) => {
		event.preventDefault();
		if (busy.current) return;
		if (!summary.trim()) return setError('Write a one-line summary of what you are proposing.');
		busy.current = true;
		setSending(true);
		setError('');
		try {
			setSent(
				await api.propose({
					fileId: file.id,
					repository: team?.id,
					package: isNew ? name.trim() : target,
					summary: summary.trim(),
					...(isNew ? { title: title.trim(), description: description.trim() } : {}),
				})
			);
		} catch (failure) {
			setError(failure.message);
		} finally {
			busy.current = false;
			setSending(false);
		}
	};

	if (sent) {
		return html`<${Dialog} title="Proposal sent" onClose=${onClose} footer=${html`<${Button} variant="outline" onClick=${onClose} data-autofocus>Close<//>`}>
			<p>Your file is on a new branch in the team repository:</p>
			<p><code>${sent.branch}</code></p>
			${sent.compareUrl
				? html`<p>Open the pull request page to ask your team to review it.</p>
						<div class="setting__actions">
							<${Button} icon="pull-request" onClick=${() => api.openTeamLink(sent.compareUrl).catch((failure) => setError(failure.message))}>Open pull request page<//>
						</div>`
				: html`<p>Open a pull request for this branch on the repository's own site.</p>`}
			${error && html`<${Alert} tone="danger" icon="alert" title=${error} />`}
		<//>`;
	}

	if (team && !team.connected) {
		return html`<${Dialog}
			title="Propose to team"
			description="No team repository is connected yet."
			onClose=${onClose}
			footer=${html`
				<${Button} variant="outline" onClick=${onClose}>Cancel<//>
				<${Button} icon="settings" onClick=${() => (onClose(), navigate({ view: 'settings' }))}>Open Settings<//>
			`}
		/>`;
	}

	const count = file.matchCount ?? 0;
	const options = [...(team?.packages ?? []).map((pkg) => ({ id: pkg.name, label: pkg.title })), { id: NEW, label: 'A new package' }];

	return html`<form onSubmit=${send}>
		<${Dialog}
			title="Propose to team"
			description=${team
				? `This sends ${count === 1 ? 'the 1 snippet' : `all ${count} snippets`} in ${file.name} to ${team.repository}, on a new branch. Anyone who can read that repository will be able to read them.`
				: 'Reading the team repository…'}
			onClose=${onClose}
			footer=${html`
				<${Button} variant="outline" onClick=${onClose}>Cancel<//>
				<${Button} type="submit" icon="pull-request" disabled=${!team || sending}>${sending ? 'Sending…' : 'Send proposal'}<//>
			`}
		>
			<${Field} label="Package">${(control) => html`<${Select} options=${options} value=${target} onChange=${setTarget} disabled=${!team} ...${control} />`}<//>
			${isNew &&
			html`
				<${Field} label="Package name" help="Lowercase letters, digits and dashes, such as shipping-replies.">
					${(control) => html`<input class="input mono" name="package" value=${name} onInput=${(event) => setName(event.target.value)} ...${control} />`}
				<//>
				<${Field} label="Title">
					${(control) => html`<input class="input" name="title" value=${title} onInput=${(event) => setTitle(event.target.value)} ...${control} />`}
				<//>
				<${Field} label="Description" help="What the package is for, in a sentence.">
					${(control) => html`<input class="input" name="description" value=${description} onInput=${(event) => setDescription(event.target.value)} ...${control} />`}
				<//>
			`}
			<${Field} label="Summary" help="One line your team will see on the pull request, such as: Add shipping replies.">
				${(control) => html`<input class="input" name="summary" data-autofocus value=${summary} onInput=${(event) => setSummary(event.target.value)} ...${control} />`}
			<//>
			${error && html`<${Alert} tone="danger" icon="alert" title=${error} />`}
		<//>
	</form>`;
}
