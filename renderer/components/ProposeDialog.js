import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { repositoryLabel } from '../../shared/repositoryLabel.js';
import { api } from '../lib/api.js';
import { Alert, Button, Dialog, Field, Select } from '../lib/ui.js';

const NEW = '+new';
// What the package choice starts on: a repository's first package, or a new one.
const firstOf = (repository) => repository?.packages[0]?.name ?? NEW;

// Sends one of your own files to a team package as a new branch. The team
// decides what happens to it: the app only ever pushes that branch.
export function ProposeDialog({ file, onClose, navigate }) {
	// The app's team status: every connected repository.
	const [team, setTeam] = useState(null);
	// The id of the repository the file goes to, or '' while none is chosen.
	const [chosen, setChosen] = useState('');
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
		api.team().then(
			(status) => {
				// With one connected there is nothing to choose. With several,
				// where a file goes is never chosen for you: everyone who can read
				// that repository will be able to read the file.
				const only = status.repositories.length === 1 ? status.repositories[0] : null;
				setTeam(status);
				setChosen(only?.id ?? '');
				setTarget(firstOf(only));
			},
			(failure) => setError(failure.message)
		);
	}, []);

	const repositories = team?.repositories ?? [];
	const several = repositories.length > 1;
	const repository = repositories.find((item) => item.id === chosen) ?? null;
	// The packages offered follow the repository: each has its own names.
	const choose = (id) => {
		setChosen(id);
		setTarget(firstOf(repositories.find((item) => item.id === id)));
		setError('');
	};
	const isNew = Boolean(repository) && target === NEW;

	const send = async (event) => {
		event.preventDefault();
		if (busy.current) return;
		if (!repository) return setError('Choose the repository to send it to.');
		if (!summary.trim()) return setError('Write a one-line summary of what you are proposing.');
		busy.current = true;
		setSending(true);
		setError('');
		try {
			setSent(
				await api.propose({
					fileId: file.id,
					repository: repository.id,
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
			<p>Your file is on a new branch in ${several ? repositoryLabel(repository.repository) : 'the team repository'}:</p>
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

	if (team && !repositories.length) {
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
	const what = `${count === 1 ? 'the 1 snippet' : `all ${count} snippets`} in ${file.name}`;
	const says = !team
		? 'Reading the team repositories…'
		: repository
			? `This sends ${what} to ${repository.repository}, on a new branch. Anyone who can read that repository will be able to read them.`
			: `This sends ${what} to one of your team's repositories, on a new branch. Choose which one. Anyone who can read it will be able to read them.`;
	const repositoryOptions = [{ id: '', label: 'Choose a repository…' }, ...repositories.map((item) => ({ id: item.id, label: repositoryLabel(item.repository) }))];
	const packageOptions = repository
		? [...repository.packages.map((pkg) => ({ id: pkg.name, label: pkg.title })), { id: NEW, label: 'A new package' }]
		: [{ id: NEW, label: several ? 'Choose a repository first' : 'A new package' }];

	return html`<form onSubmit=${send}>
		<${Dialog}
			title="Propose to team"
			description=${says}
			onClose=${onClose}
			footer=${html`
				<${Button} variant="outline" onClick=${onClose}>Cancel<//>
				<${Button} type="submit" icon="pull-request" disabled=${!repository || sending}>${sending ? 'Sending…' : 'Send proposal'}<//>
			`}
		>
			${several &&
			html`<${Field} label="Repository">${(control) => html`<${Select} name="repository" options=${repositoryOptions} value=${chosen} onChange=${choose} ...${control} />`}<//>`}
			<${Field} label="Package">${(control) => html`<${Select} name="target" options=${packageOptions} value=${target} onChange=${setTarget} disabled=${!repository} ...${control} />`}<//>
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
