import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { searchFiles } from '../../shared/search.js';
import { api, refOf } from '../lib/api.js';
import { Alert, Badge, Button, ConfirmDialog, Empty, IconButton, useToast } from '../lib/ui.js';
import { SnippetList, rowsOf } from './SnippetList.js';

function RawEditor({ file, refresh, setDirty }) {
	const toast = useToast();
	const [loaded, setLoaded] = useState(null);
	const [text, setText] = useState('');
	const [errors, setErrors] = useState('');
	// A textarea holds line breaks as LF. A file written with CRLF is shown
	// that way and saved back with CRLF, so its other lines do not change.
	const usesCrlf = loaded !== null && loaded.text.includes('\r\n') && !/[^\r]\n/.test(loaded.text);
	const shown = (value) => value.replace(/\r\n/g, '\n');
	const dirty = loaded !== null && text !== shown(loaded.text);

	const load = async () => {
		try {
			const fresh = await api.readFile(refOf(file));
			setLoaded(fresh);
			setText(shown(fresh.text));
			setErrors('');
		} catch (failure) {
			setErrors(failure.message);
		}
	};

	// Reload when the file changes on disk, unless there are edits to keep.
	useEffect(() => {
		if (!dirty) load();
	}, [file.version]);

	// Set while rendering so navigation never reads a stale flag.
	setDirty(dirty);
	useEffect(() => () => setDirty(false), []);

	const save = async () => {
		if (!dirty) return;
		try {
			const saved = await api.saveRaw(refOf(file), { text: usesCrlf ? text.replace(/\n/g, '\r\n') : text, version: loaded.version });
			setLoaded(saved);
			setText(shown(saved.text));
			setErrors('');
			toast({ title: 'Saved', description: `${file.name} is updated.` });
			await refresh();
		} catch (failure) {
			setErrors(failure.message);
			if (failure.code !== 'PARSE_ERROR') toast({ tone: 'error', title: 'Could not save', description: failure.message });
		}
	};

	const saveRef = useRef(save);
	saveRef.current = save;
	useEffect(() => {
		const onKey = (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
				event.preventDefault();
				saveRef.current();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	const onDisk = loaded !== null && loaded.version !== file.version;

	return html`<div class="stack">
		${errors && html`<${Alert} tone="danger" icon="alert" title="This YAML cannot be saved yet"><p>${errors}</p><//>`}
		${onDisk &&
		dirty &&
		html`<${Alert} tone="warning" icon="alert" title="This file changed on disk" actions=${html`<${Button} variant="outline" size="sm" icon="refresh" onClick=${load}>Load the version on disk<//>`}>
			<p>Another program edited it while you had changes here. Loading it replaces your edits.</p>
		<//>`}
		<textarea
			class="textarea code-area raw-editor"
			aria-label=${`Raw YAML of ${file.name}`}
			spellcheck=${false}
			value=${text}
			readonly=${file.readOnly}
			disabled=${loaded === null}
			onInput=${(event) => setText(event.target.value)}
		></textarea>
		${!file.readOnly &&
		html`<div class="toolbar">
			<${Button} icon="check" disabled=${!dirty} onClick=${save}>Save YAML<//>
			<${Button} variant="outline" disabled=${!dirty} onClick=${() => setText(shown(loaded.text))}>Revert<//>
			<span class="muted">${dirty ? 'Unsaved changes' : 'Comments, imports and global_vars are edited here.'}</span>
		</div>`}
	</div>`;
}

export function FileView({ state, file, tab, navigate, refresh, setDirty, onEditDetails, onNewSnippet }) {
	const toast = useToast();
	const [filter, setFilter] = useState('');
	const [confirmDelete, setConfirmDelete] = useState(false);
	const broken = file.matches === null;
	const activeTab = broken ? 'raw' : tab ?? 'snippets';
	const pkg = file.source === 'package' ? state.packages.find((candidate) => candidate.name === file.package) : null;

	const rows = filter.trim() ? searchFiles([file], filter).map((hit) => ({ file, index: hit.index, match: hit.match })) : rowsOf(file);

	const remove = async () => {
		setConfirmDelete(false);
		try {
			await api.deleteFile(refOf(file), { version: file.version });
			toast({ title: 'File deleted', description: `A backup of ${file.name} was kept.` });
			setDirty(false);
			await refresh();
			navigate({ view: 'overview' }, { force: true });
		} catch (failure) {
			toast({ tone: 'error', title: 'Could not delete', description: failure.message });
		}
	};

	return html`<div class="page">
		<div class="page-head">
			<div class="page-head__text">
				<h1 class="truncate">${pkg ? `${pkg.title} / ${file.name}` : file.name}</h1>
				${(pkg?.description || file.description) && html`<p>${pkg?.description || file.description}</p>`}
				<div class="page-head__meta">
					${!broken && html`<${Badge}>${file.matchCount} ${file.matchCount === 1 ? 'snippet' : 'snippets'}<//>`}
					${file.prefix && html`<${Badge}>Prefix <span class="chip chip--prefix">${file.prefix}</span><//>`}
					${file.importOnly && html`<${Badge}>Import only<//>`}
					${file.readOnly && html`<${Badge} icon="lock">Read-only<//>`}
					${pkg?.version && html`<${Badge}>v${pkg.version}<//>`} ${pkg?.author && html`<${Badge}>${pkg.author}<//>`}
					${broken && html`<${Badge} tone="danger" icon="alert">${file.unreadable ? 'Not opened' : 'YAML errors'}<//>`}
				</div>
			</div>
			${!file.readOnly &&
			html`<div class="page-head__actions">
				<${IconButton} label="Delete file" icon="trash" variant="outline" onClick=${() => setConfirmDelete(true)} />
				<${Button} variant="outline" icon="pencil" disabled=${broken} onClick=${() => onEditDetails(file)}>Details<//>
				<${Button} icon="plus" disabled=${broken} onClick=${() => onNewSnippet(file)}>New snippet<//>
			</div>`}
		</div>

		${!file.unreadable &&
		html`<div class="tabs" role="tablist">
			<button role="tab" aria-selected=${activeTab === 'snippets' ? 'true' : 'false'} disabled=${broken} onClick=${() => navigate({ view: 'file', fileId: file.id, tab: 'snippets' })}>Snippets</button>
			<button role="tab" aria-selected=${activeTab === 'raw' ? 'true' : 'false'} onClick=${() => navigate({ view: 'file', fileId: file.id, tab: 'raw' })}>Raw YAML</button>
		</div>`}

		${file.unreadable && html`<${Alert} tone="danger" icon="alert" title="This file could not be opened here"><p>${file.parseErrors[0]}</p><//>`}

		${broken &&
		!file.unreadable &&
		html`<div class="stack">
			<${Alert} tone="danger" icon="alert" title="Espanso cannot load this file until its YAML is fixed">
				<ul>
					${file.parseErrors.map((message) => html`<li>${message}</li>`)}
				</ul>
			<//>
			<${RawEditor} key=${file.id} file=${file} refresh=${refresh} setDirty=${setDirty} />
		</div>`}

		${!broken && activeTab === 'raw' && html`<${RawEditor} key=${file.id} file=${file} refresh=${refresh} setDirty=${setDirty} />`}

		${!broken &&
		activeTab === 'snippets' &&
		(file.matchCount === 0
			? html`<${Empty} icon="file" title="No snippets in this file yet" actions=${!file.readOnly && html`<${Button} icon="plus" onClick=${() => onNewSnippet(file)}>New snippet<//>`}>
					A snippet pairs a trigger you type with the text it expands to.
				<//>`
			: html`
					${file.matchCount > 6 &&
					html`<div class="toolbar">
						<input class="input" type="search" placeholder="Filter this file" aria-label="Filter this file" value=${filter} onInput=${(event) => setFilter(event.target.value)} />
						${filter.trim() && html`<span class="muted">${rows.length} of ${file.matchCount}</span>`}
					</div>`}
					${rows.length
						? html`<${SnippetList} rows=${rows} onOpen=${(target, index) => navigate({ view: 'snippet', fileId: target.id, index })} />`
						: html`<p class="list-note">Nothing in this file matches “${filter}”.</p>`}
				`)}

		${confirmDelete &&
		html`<${ConfirmDialog}
			title=${`Delete ${file.name}?`}
			description=${`Its ${file.matchCount ?? 0} snippets stop expanding in Espanso. A backup copy is kept in the app's backups folder.`}
			confirmLabel="Delete file"
			destructive
			onConfirm=${remove}
			onClose=${() => setConfirmDelete(false)}
		/>`}
	</div>`;
}
