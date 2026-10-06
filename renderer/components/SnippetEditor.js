import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import {
	CONTENT_TYPES,
	FORCE_MODES,
	KNOWN_KEYS,
	TRIGGER_MODES,
	UPPERCASE_STYLES,
	applyDraft,
	deepEqual,
	draftToMatch,
	emptyDraft,
	matchToDraft,
	matchTriggers,
	validateDraft,
} from '../../shared/snippetModel.js';
import { api, refOf } from '../lib/api.js';
import { Alert, Badge, Button, Card, ConfirmDialog, Empty, Field, Repeater, Segmented, Select, Switch, cx, useToast } from '../lib/ui.js';
import { FormFieldsEditor, RawYamlField, VarsEditor } from './VarsEditor.js';

const CONTENT_HELP = {
	replace: 'Use {{name}} for a variable and $|$ for where the cursor should land.',
	markdown: 'Markdown is converted to rich text when the snippet expands.',
	html: 'HTML is pasted as rich text when the snippet expands.',
	form: 'Write the form as text. Each [[name]] becomes a field you fill in before the snippet expands.',
	image_path: 'The full path to an image. %CONFIG% stands for the Espanso config folder.',
};

function checkExtras(value) {
	if (value === undefined) return '';
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'Other keys must be a mapping of names to values.';
	const clash = Object.keys(value).find((key) => KNOWN_KEYS.includes(key));
	return clash ? `Set "${clash}" in the form instead.` : '';
}

export function SnippetEditor({ state, file, index, seed, insertAt, navigate, refresh, setDirty }) {
	const toast = useToast();
	const isNew = index === 'new';
	const readOnly = file.readOnly;
	const original = isNew ? undefined : file.matches?.[index];
	const localFiles = state.files.filter((candidate) => candidate.matches !== null && !candidate.readOnly);

	// The match this draft started from. It moves forward on save and when the
	// file changes on disk under a draft that has no edits to lose.
	const [base, setBase] = useState(original);
	const [draft, setDraft] = useState(() => (isNew ? (seed ? matchToDraft(seed) : emptyDraft({ prefix: file.prefix })) : original ? matchToDraft(original) : emptyDraft()));
	const [attempted, setAttempted] = useState(false);
	const [rawInvalid, setRawInvalidState] = useState({});
	const [preview, setPreview] = useState('');
	const [saving, setSaving] = useState(false);
	// `saving` only changes on the next draw, so a second click in the same
	// instant would still see it as false. This is checked at once.
	const busy = useRef(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [copyTarget, setCopyTarget] = useState(localFiles.find((candidate) => !candidate.importOnly)?.id ?? localFiles[0]?.id ?? '');

	const set = (patch) => setDraft((current) => ({ ...current, ...patch }));
	const setRawInvalid = (key, invalid) =>
		setRawInvalidState((current) => (Boolean(current[key]) === invalid ? current : { ...current, [key]: invalid }));
	const hasRawErrors = Object.values(rawInvalid).some(Boolean);

	const baseline = useMemo(() => (isNew ? draftToMatch(seed ? matchToDraft(seed) : emptyDraft({ prefix: file.prefix })) : base ? draftToMatch(matchToDraft(base)) : {}), [base]);
	const edited = draftToMatch(draft);
	const dirty = isNew ? Boolean(seed) || !deepEqual(edited, baseline) : !deepEqual(edited, baseline);
	const toSave = isNew ? edited : base ? applyDraft(base, draft) : edited;
	const stale = !isNew && original !== undefined && !deepEqual(original, base);
	// List positions shift when another program adds or removes a snippet, so
	// a changed trigger means this position now holds something else.
	const moved = stale && !deepEqual(matchTriggers(original), matchTriggers(base ?? {}));
	const adopt = (match, discardEdits) => {
		setBase(match);
		if (discardEdits) setDraft(matchToDraft(match));
	};

	// Set while rendering, not in an effect: navigation reads this flag, and an
	// effect can run a frame after the keystroke that changed it.
	setDirty(dirty && !readOnly);
	useEffect(() => () => setDirty(false), []);

	// Problems show after the first save attempt, then follow the draft so a
	// message disappears as soon as its field is fixed.
	const problems = validateDraft(draft, { prefix: isNew ? file.prefix : '' });
	const errors = attempted ? Object.fromEntries(problems.map((problem) => [problem.field, problem.message])) : {};

	// Follow the file when it changes on disk and there is nothing to lose.
	const originalKey = JSON.stringify(original);
	useEffect(() => {
		if (isNew || original === undefined || deepEqual(original, base) || dirty) return;
		setBase(original);
		setDraft(matchToDraft(original));
	}, [originalKey]);

	const toSaveKey = JSON.stringify(toSave);
	useEffect(() => {
		const timer = setTimeout(() => {
			api.previewMatch(toSave).then(setPreview, () => setPreview(''));
		}, 150);
		return () => clearTimeout(timer);
	}, [toSaveKey]);

	const fail = (failure) => {
		toast({ tone: 'error', title: failure.code === 'CONFLICT' ? 'The file changed on disk' : 'Could not save', description: failure.message });
		if (failure.code === 'CONFLICT') refresh();
	};

	const save = async () => {
		if (busy.current || saving || readOnly || stale) return;
		setAttempted(true);
		if (problems.length || hasRawErrors) {
			toast({ tone: 'error', title: 'Not saved yet', description: problems[0]?.message ?? 'Fix the YAML errors first.' });
			return;
		}
		busy.current = true;
		setSaving(true);
		try {
			if (isNew) {
				const saved = await api.createMatch(refOf(file), { match: toSave, index: insertAt, version: file.version });
				const at = Number.isInteger(insertAt) ? Math.min(insertAt, saved.matches.length - 1) : saved.matches.length - 1;
				toast({ title: 'Snippet added', description: `Saved to ${file.name}.` });
				setDirty(false);
				await refresh();
				navigate({ view: 'snippet', fileId: file.id, index: at }, { force: true });
			} else {
				const saved = await api.updateMatch(refOf(file), { index, match: toSave, version: file.version });
				// The window's picture of the file is brought up to date before
				// the editor says "Saved". Whatever is done next, such as adding
				// another snippet to this file, then starts from the new version.
				await refresh();
				setBase(saved.matches[index]);
				setDraft(matchToDraft(saved.matches[index]));
				setAttempted(false);
				toast({ title: 'Saved', description: `${file.name} is updated.` });
			}
		} catch (failure) {
			fail(failure);
		} finally {
			busy.current = false;
			setSaving(false);
		}
	};

	useEffect(() => {
		if (!isNew) return;
		const first = document.querySelector('.editor input');
		first?.focus();
		first?.setSelectionRange?.(first.value.length, first.value.length);
	}, []);

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

	const remove = async () => {
		setConfirmDelete(false);
		// Positions shift when the file changes on disk; never delete by a
		// position that may now hold a different snippet.
		if (stale) return;
		try {
			await api.deleteMatch(refOf(file), { index, version: file.version });
			toast({ title: 'Snippet deleted', description: `A backup of ${file.name} was kept.` });
			setDirty(false);
			await refresh();
			navigate({ view: 'file', fileId: file.id }, { force: true });
		} catch (failure) {
			fail(failure);
		}
	};

	const copyToLocal = async () => {
		const target = localFiles.find((candidate) => candidate.id === copyTarget);
		if (!target) return;
		try {
			const saved = await api.createMatch(refOf(target), { match: original, version: target.version });
			toast({ title: 'Copied', description: `Added to ${target.name}.` });
			await refresh();
			navigate({ view: 'snippet', fileId: target.id, index: saved.matches.length - 1 }, { force: true });
		} catch (failure) {
			fail(failure);
		}
	};

	if (!isNew && original === undefined) {
		return html`<div class="page">
			<${Empty}
				icon="alert"
				title="This snippet is no longer here"
				actions=${html`<${Button} onClick=${() => navigate({ view: 'file', fileId: file.id }, { force: true })}>Back to ${file.name}<//>`}
			>
				${file.matches === null ? `${file.name} has YAML errors, so its snippets cannot be read.` : `${file.name} changed on disk and no longer has a snippet at this position.`}
			<//>
		</div>`;
	}

	const title = isNew ? 'New snippet' : draft.label || edited.trigger || edited.triggers?.[0] || edited.regex || 'Snippet';

	return html`<div class="page page--wide">
		<div class="page-head">
			<div class="page-head__text">
				<h1 class="truncate">${title}</h1>
				<div class="page-head__meta">
					<${Badge} icon=${file.source === 'package' ? 'package' : 'file'}>${file.source === 'package' ? `${file.package} / ${file.name}` : file.name}<//>
					${readOnly && html`<${Badge} icon="lock">Read-only<//>`} ${!readOnly && dirty && html`<${Badge} tone="accent">Unsaved changes<//>`}
				</div>
			</div>
			<div class="page-head__actions">
				${!isNew &&
				!readOnly &&
				html`<${Button} variant="outline" icon="copy" onClick=${() => navigate({ view: 'snippet', fileId: file.id, index: 'new', seed: toSave, insertAt: index + 1 })}>
					Duplicate
				<//>`}
			</div>
		</div>

		<div class="stack">
			${readOnly &&
			html`<${Alert} icon="lock" title=${file.source === 'package' ? 'This snippet belongs to a package' : `${file.name} is write-protected`}>
				<p>
					${file.source === 'package'
						? 'Packages are read-only here. Copy the snippet into one of your own files to change it.'
						: 'Change the permissions of the file to edit it here, or copy the snippet into another file.'}
				</p>
				${localFiles.length > 0 &&
				html`<div class="alert__actions">
					<${Select} aria-label="File to copy into" options=${localFiles.map((candidate) => ({ id: candidate.id, label: candidate.name }))} value=${copyTarget} onChange=${setCopyTarget} />
					<${Button} icon="copy" onClick=${copyToLocal}>Copy to my file<//>
				</div>`}
			<//>`}
			${stale &&
			html`<${Alert}
				tone="warning"
				icon="alert"
				title=${moved ? 'A different snippet is at this position now' : 'This snippet changed on disk'}
				actions=${html`
					<${Button} variant="outline" size="sm" icon="refresh" onClick=${() => adopt(original, true)}>Load the version on disk<//>
					${!moved && html`<${Button} variant="outline" size="sm" onClick=${() => adopt(original, false)}>Keep my edits<//>`}
				`}
			>
				<p>
					${moved
						? `${file.name} was edited in another program and its snippets moved. Load the version on disk before making changes.`
						: 'Another program edited it while you had unsaved changes. Choose which version to continue with before saving.'}
				</p>
			<//>`}

			<div class="editor">
				<div class="stack">
					<${Card} title="Trigger" description="What you type to expand this snippet.">
						<${Segmented} label="Trigger type" options=${TRIGGER_MODES} value=${draft.triggerMode} disabled=${readOnly} onChange=${(triggerMode) => set({ triggerMode })} />
						${draft.triggerMode === 'single' &&
						html`<${Field} label="Trigger" error=${errors.trigger} help=${isNew && file.prefix ? `Triggers in ${file.name} start with "${file.prefix}".` : undefined}>
							${(control) => html`<input class="input mono" value=${draft.trigger} placeholder=":hello" disabled=${readOnly} onInput=${(event) => set({ trigger: event.target.value })} ...${control} />`}
						<//>`}
						${draft.triggerMode === 'multiple' &&
						html`<div class="field">
							<span class="field__label">Triggers</span>
							<${Repeater} label="Trigger" addLabel="Add trigger" mono minRows=${1} placeholder=":hello" values=${draft.triggers} disabled=${readOnly} onChange=${(triggers) => set({ triggers })} />
							${errors.triggers && html`<p class="field__error" role="alert">${errors.triggers}</p>`}
						</div>`}
						${draft.triggerMode === 'regex' &&
						html`<${Field} label="Regex pattern" error=${errors.regex} help="Rust regex syntax. A named group such as (?P<id>\\d+) becomes the variable {{id}}.">
							${(control) => html`<input class="input mono" value=${draft.regex} placeholder=":ticket(?P<id>\\d+)" disabled=${readOnly} onInput=${(event) => set({ regex: event.target.value })} ...${control} />`}
						<//>`}
						<${Field} label="Label" help="A friendly name shown in Espanso's search bar and in this app.">
							${(control) => html`<input class="input" value=${draft.label} disabled=${readOnly} onInput=${(event) => set({ label: event.target.value })} ...${control} />`}
						<//>
					<//>

					<${Card} title="Content" description="What the trigger turns into.">
						<${Field} label="Type">
							${(control) => html`<${Select} options=${CONTENT_TYPES} value=${draft.contentType} disabled=${readOnly} onChange=${(contentType) => set({ contentType })} ...${control} />`}
						<//>
						<${Field} label=${draft.contentType === 'image_path' ? 'Image path' : draft.contentType === 'form' ? 'Form layout' : 'Text'} help=${CONTENT_HELP[draft.contentType]} error=${errors.content}>
							${(control) =>
								draft.contentType === 'image_path'
									? html`<input class="input mono" value=${draft.content} placeholder="%CONFIG%/images/logo.png" disabled=${readOnly} onInput=${(event) => set({ content: event.target.value })} ...${control} />`
									: html`<textarea
											class=${cx('textarea', draft.contentType !== 'replace' && draft.contentType !== 'form' && 'code-area')}
											rows=${Math.min(18, Math.max(5, draft.content.split('\n').length + 1))}
											value=${draft.content}
											disabled=${readOnly}
											onInput=${(event) => set({ content: event.target.value.replace(/\r\n/g, '\n') })}
											...${control}
										></textarea>`}
						<//>
						${draft.contentType === 'form' &&
						html`<${FormFieldsEditor}
							fields=${draft.formFields}
							layout=${draft.content}
							disabled=${readOnly}
							onValidity=${(valid) => setRawInvalid('form_fields', !valid)}
							onChange=${(formFields) => set({ formFields })}
						/>`}
					<//>

					<${Card} title="Variables">
						${draft.varsRaw === undefined
							? html`<${VarsEditor} vars=${draft.vars} errors=${errors} disabled=${readOnly} setRawInvalid=${setRawInvalid} onChange=${(vars) => set({ vars })} />`
							: html`<${RawYamlField}
									key=${`vars-${JSON.stringify(base ?? null)}`}
									label="Variables (YAML)"
									help="These variables are written in a shape the form cannot show, so they are edited as YAML."
									value=${draft.varsRaw}
									disabled=${readOnly}
									rows=${8}
									onValidity=${(valid) => setRawInvalid('vars', !valid)}
									onChange=${(vars) => set({ varsRaw: vars ?? [] })}
								/>`}
					<//>

					<${Card} title="Options">
						<${Switch} title="Whole words only" description="Expand only when the trigger stands alone, not inside a longer word." checked=${draft.word} disabled=${readOnly} onChange=${(word) => set({ word })} />
						<${Switch}
							title="Follow my capitalisation"
							description="Typing the trigger capitalised or in capitals changes the expansion to match."
							checked=${draft.propagateCase}
							disabled=${readOnly}
							onChange=${(propagateCase) => set({ propagateCase })}
						/>
						<div class="field-row">
							<${Field} label="Capitalisation style" help="Used when the trigger is typed with a capital.">
								${(control) => html`<${Select} options=${UPPERCASE_STYLES} value=${draft.uppercaseStyle} disabled=${readOnly || !draft.propagateCase} onChange=${(uppercaseStyle) => set({ uppercaseStyle })} ...${control} />`}
							<//>
							<${Field} label="How to insert" help="Clipboard is faster for long text. Keystrokes work in more apps.">
								${(control) => html`<${Select} options=${FORCE_MODES} value=${draft.forceMode} disabled=${readOnly} onChange=${(forceMode) => set({ forceMode })} ...${control} />`}
							<//>
						</div>
						${draft.searchTermsRaw === undefined
							? html`<div class="field">
									<span class="field__label">Search terms</span>
									<${Repeater} label="Search term" addLabel="Add search term" values=${draft.searchTerms} disabled=${readOnly} onChange=${(searchTerms) => set({ searchTerms })} />
									<p class="field__help">Extra words that find this snippet in Espanso's search bar.</p>
								</div>`
							: html`<p class="field__help">This snippet's search terms are not a list, so they are kept exactly as written in the file.</p>`}
					<//>
				</div>

				<aside class="editor__aside" aria-label="Preview">
					<${Card} title="YAML" description=${readOnly ? 'How this snippet is written in the file.' : 'What will be written to the file.'}>
						<pre class="code-block" tabindex="0" aria-label="YAML preview">${preview}</pre>
					<//>
					<${Card} title="Other keys" description="Espanso options this form does not cover, such as left_word or apps.">
						<${RawYamlField}
							key=${JSON.stringify(base ?? null)}
							label="Other keys (YAML)"
							value=${draft.extras}
							disabled=${readOnly}
							rows=${4}
							check=${checkExtras}
							onValidity=${(valid) => setRawInvalid('extras', !valid)}
							onChange=${(extras) => set({ extras: extras ?? {} })}
						/>
					<//>
				</aside>
			</div>
		</div>

		${!readOnly &&
		html`<div class="action-bar">
			${!isNew && html`<${Button} variant="danger-ghost" icon="trash" disabled=${stale} onClick=${() => setConfirmDelete(true)}>Delete<//>`}
			<span class="spacer"></span>
			<span class="action-bar__status">${hasRawErrors ? 'Fix the YAML errors to save.' : dirty ? 'Unsaved changes' : isNew ? '' : 'Saved'}</span>
			<${Button} variant="outline" onClick=${() => navigate({ view: 'file', fileId: file.id })}>${dirty ? 'Cancel' : 'Close'}<//>
			<${Button} icon="check" disabled=${saving || stale || hasRawErrors || (!isNew && !dirty)} onClick=${save}>${isNew ? 'Add snippet' : 'Save'}<//>
		</div>`}

		${confirmDelete &&
		html`<${ConfirmDialog}
			title="Delete this snippet?"
			description=${`It is removed from ${file.name}. A backup of the file is kept first.`}
			confirmLabel="Delete snippet"
			destructive
			onConfirm=${remove}
			onClose=${() => setConfirmDelete(false)}
		/>`}
	</div>`;
}
