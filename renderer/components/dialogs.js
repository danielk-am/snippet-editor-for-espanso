import { html, useState } from '../vendor/preact-htm.js';
import { api, refOf } from '../lib/api.js';
import { Button, Dialog, Field, useToast } from '../lib/ui.js';

const withExtension = (name) => (/\.ya?ml$/i.test(name) ? name : `${name}.yml`);

function DetailsFields({ description, setDescription, prefix, setPrefix }) {
	return html`
		<${Field} label="Description" help="Kept as the first comment line of the file.">
			${(control) => html`<input class="input" value=${description} onInput=${(event) => setDescription(event.target.value)} ...${control} />`}
		<//>
		<${Field} label="Trigger prefix" help="Optional. New snippets in this file start with it, for example ; or :.">
			${(control) => html`<input class="input mono" value=${prefix} onInput=${(event) => setPrefix(event.target.value)} ...${control} />`}
		<//>
	`;
}

export function NewFileDialog({ onClose, onCreated }) {
	const toast = useToast();
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [prefix, setPrefix] = useState('');
	const [error, setError] = useState('');

	const create = async (event) => {
		event.preventDefault();
		const fileName = withExtension(name.trim());
		if (!name.trim()) return setError('Give the file a name.');
		try {
			const file = await api.createFile({ name: fileName, description: description.trim(), prefix });
			toast({ title: 'File created', description: fileName });
			onCreated(file);
		} catch (failure) {
			setError(failure.message);
		}
	};

	return html`<form onSubmit=${create}>
		<${Dialog}
			title="New match file"
			description="Espanso loads every .yml file in the match folder."
			onClose=${onClose}
			footer=${html`
				<${Button} variant="outline" onClick=${onClose}>Cancel<//>
				<${Button} type="submit">Create file<//>
			`}
		>
			<${Field} label="File name" help="For example work.yml. A name starting with _ is loaded only when another file imports it." error=${error}>
				${(control) => html`<input class="input mono" data-autofocus placeholder="work.yml" value=${name} onInput=${(event) => setName(event.target.value)} ...${control} />`}
			<//>
			<${DetailsFields} description=${description} setDescription=${setDescription} prefix=${prefix} setPrefix=${setPrefix} />
		<//>
	</form>`;
}

export function FileDetailsDialog({ file, onClose, onSaved }) {
	const toast = useToast();
	const [description, setDescription] = useState(file.description);
	const [prefix, setPrefix] = useState(file.prefix);
	const [error, setError] = useState('');

	const save = async (event) => {
		event.preventDefault();
		try {
			await api.setHeader(refOf(file), { description: description.trim(), prefix, version: file.version });
			toast({ title: 'Details saved', description: file.name });
			onSaved();
		} catch (failure) {
			setError(failure.message);
		}
	};

	return html`<form onSubmit=${save}>
		<${Dialog}
			title=${`Details of ${file.name}`}
			onClose=${onClose}
			footer=${html`
				<${Button} variant="outline" onClick=${onClose}>Cancel<//>
				<${Button} type="submit">Save details<//>
			`}
		>
			<${DetailsFields} description=${description} setDescription=${setDescription} prefix=${prefix} setPrefix=${setPrefix} />
			${error && html`<p class="field__error" role="alert">${error}</p>`}
		<//>
	</form>`;
}
