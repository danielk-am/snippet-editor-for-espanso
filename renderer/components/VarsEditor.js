import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import {
	FIELD_KINDS,
	VAR_TYPES,
	defaultVar,
	fieldsToRows,
	isStructuredFields,
	isStructuredVar,
	rowsToFields,
	varSpec,
} from '../../shared/varsModel.js';
import { api } from '../lib/api.js';
import { Button, Field, IconButton, Repeater, Select, Switch, cx } from '../lib/ui.js';

// YAML for the shapes the form cannot express. Parsed as you type; the parent
// hears about each valid value and about whether the text currently parses.
export function RawYamlField({ label, help, value, onChange, onValidity, disabled, rows = 5, check }) {
	const [text, setText] = useState(null);
	const [error, setError] = useState('');
	const sequence = useRef(0);

	useEffect(() => {
		let live = true;
		const empty = value === undefined || value === null || (typeof value === 'object' && !Object.keys(value).length);
		(empty ? Promise.resolve('') : api.stringifyYaml(value)).then((yaml) => live && setText(yaml));
		return () => {
			live = false;
			onValidity?.(true);
		};
	}, []);

	const fail = (message) => {
		setError(message);
		onValidity?.(false);
	};

	const onInput = async (event) => {
		const next = event.target.value;
		setText(next);
		const turn = (sequence.current += 1);
		try {
			const parsed = next.trim() ? await api.parseYaml(next) : undefined;
			if (turn !== sequence.current) return;
			const problem = check?.(parsed);
			if (problem) return fail(problem);
			setError('');
			onValidity?.(true);
			onChange(parsed);
		} catch (failure) {
			if (turn === sequence.current) fail(failure.message);
		}
	};

	return html`<${Field} label=${label} help=${help} error=${error}>
		${(control) =>
			html`<textarea
				class="textarea code-area"
				rows=${rows}
				spellcheck=${false}
				value=${text ?? ''}
				disabled=${disabled || text === null}
				onInput=${onInput}
				...${control}
			></textarea>`}
	<//>`;
}

const isMapping = (value) => value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value));

export function FormFieldsEditor({ fields, layout, onChange, onValidity, disabled }) {
	if (!isStructuredFields(fields)) {
		return html`<${RawYamlField}
			label="Field settings (YAML)"
			help="These fields use options the form below cannot show, so they are edited as YAML."
			value=${fields}
			disabled=${disabled}
			onChange=${onChange}
			onValidity=${onValidity}
			check=${(value) => (isMapping(value) ? '' : 'Field settings must be a mapping of field names.')}
		/>`;
	}

	const rows = fieldsToRows(fields, layout);
	if (!rows.length) {
		return html`<p class="field__help">Add a field to the layout with double square brackets, for example <code>[[name]]</code>.</p>`;
	}
	const update = (index, patch) => onChange(rowsToFields(rows.map((row, i) => (i === index ? { ...row, ...patch } : row))));

	return html`<div class="repeater" role="group" aria-label="Form fields">
		${rows.map(
			(row, index) =>
				html`<div class="field-grid">
					<div class="field-grid__name"><span class="chip">${row.name}</span></div>
					<${Select}
						aria-label=${`Type of field ${row.name}`}
						options=${FIELD_KINDS}
						value=${row.kind}
						disabled=${disabled}
						onChange=${(kind) => update(index, { kind })}
					/>
					${(row.kind === 'choice' || row.kind === 'list') &&
					html`<textarea
						class="textarea"
						rows="3"
						placeholder="One option per line"
						aria-label=${`Options for field ${row.name}`}
						value=${row.values.join('\n')}
						disabled=${disabled}
						onInput=${(event) => update(index, { values: event.target.value.split('\n') })}
					></textarea>`}
				</div>`
		)}
	</div>`;
}

const SHELLS = ['', 'bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh', 'wsl', 'nu'].map((id) => ({
	id,
	label: id || 'System default',
}));

function VarParams({ variable, setParams, onValidity, disabled }) {
	const params = variable.params ?? {};
	// Optional params are removed when emptied, so the YAML stays minimal.
	const set = (key, value, optional) => {
		const next = { ...params };
		if (optional && (value === '' || value === undefined)) delete next[key];
		else next[key] = value;
		setParams(next);
	};
	const text = (key, label, extra = {}) => html`<${Field} label=${label} help=${extra.help}>
		${(control) =>
			html`<input
				class=${cx('input', extra.mono && 'mono')}
				value=${params[key] ?? ''}
				placeholder=${extra.placeholder}
				disabled=${disabled}
				onInput=${(event) => set(key, event.target.value, extra.optional)}
				...${control}
			/>`}
	<//>`;

	switch (variable.type) {
		case 'date':
			return html`${text('format', 'Format', { mono: true, help: 'strftime codes. %Y-%m-%d gives 2026-10-05; %H:%M gives 14:30.' })}
				<div class="field-row">
					<${Field} label="Offset in seconds" help="86400 is tomorrow; -86400 is yesterday.">
						${(control) =>
							html`<input
								class="input"
								type="number"
								value=${params.offset ?? ''}
								disabled=${disabled}
								onInput=${(event) => set('offset', event.target.value === '' ? '' : Number(event.target.value), true)}
								...${control}
							/>`}
					<//>
					${text('locale', 'Locale', { placeholder: 'en-US', optional: true })}
				</div>`;
		case 'echo':
			return text('echo', 'Text');
		case 'match':
			return text('trigger', 'Trigger of the other snippet', { mono: true });
		case 'shell':
			return html`<${Field} label="Command">
					${(control) =>
						html`<textarea
							class="textarea code-area"
							rows="2"
							spellcheck=${false}
							value=${params.cmd ?? ''}
							disabled=${disabled}
							onInput=${(event) => set('cmd', event.target.value)}
							...${control}
						></textarea>`}
				<//>
				<${Field} label="Shell">
					${(control) => html`<${Select} options=${SHELLS} value=${params.shell ?? ''} disabled=${disabled} onChange=${(value) => set('shell', value, true)} ...${control} />`}
				<//>
				<${Switch}
					title="Trim the output"
					description="Remove spaces and line breaks around what the command prints."
					checked=${params.trim !== false}
					disabled=${disabled}
					onChange=${(on) => set('trim', on ? undefined : false, true)}
				/>`;
		case 'script':
			return html`<${Repeater} label="Argument" addLabel="Add argument" mono values=${params.args ?? []} disabled=${disabled} onChange=${(args) => set('args', args)} />`;
		case 'random':
			return html`<${Repeater} label="Choice" addLabel="Add choice" values=${params.choices ?? []} disabled=${disabled} onChange=${(choices) => set('choices', choices)} />`;
		case 'choice':
			return html`<${Repeater} label="Value" addLabel="Add value" values=${params.values ?? []} disabled=${disabled} onChange=${(values) => set('values', values)} />`;
		case 'form':
			return html`<${Field} label="Layout" help="Write the form as text. Each [[name]] becomes a field.">
					${(control) =>
						html`<textarea
							class="textarea"
							rows="3"
							value=${params.layout ?? ''}
							disabled=${disabled}
							onInput=${(event) => set('layout', event.target.value)}
							...${control}
						></textarea>`}
				<//>
				<${FormFieldsEditor}
					fields=${params.fields}
					layout=${params.layout}
					disabled=${disabled}
					onValidity=${onValidity}
					onChange=${(fields) => set('fields', fields && Object.keys(fields).length ? fields : undefined, true)}
				/>`;
		default:
			return html`<p class="field__help">Nothing to set.</p>`;
	}
}

export function VarsEditor({ vars, onChange, errors, setRawInvalid, disabled }) {
	const [newType, setNewType] = useState('date');
	const typeOptions = Object.entries(VAR_TYPES).map(([id, spec]) => ({ id, label: spec.label }));
	const update = (index, patch) => onChange(vars.map((variable, i) => (i === index ? { ...variable, ...patch } : variable)));

	return html`<div class="stack">
		${!vars.length &&
		html`<p class="field__help">
			Variables fill in text when a snippet expands: today's date, the clipboard, the output of a command. Use one in
			the content as <code>${'{{name}}'}</code>.
		</p>`}
		${vars.map((variable, index) => {
			const known = varSpec(variable.type);
			const options = known ? typeOptions : [...typeOptions, { id: variable.type ?? '', label: `${variable.type ?? 'Unknown'} (custom)` }];
			const structured = isStructuredVar(variable);
			return html`<div class="var-row" key=${index}>
				<div class="var-row__head">
					<${Field} label="Name" error=${errors[`vars.${index}`]}>
						${(control) =>
							html`<input
								class="input mono"
								value=${variable.name ?? ''}
								disabled=${disabled}
								onInput=${(event) => update(index, { name: event.target.value })}
								...${control}
							/>`}
					<//>
					<${Field} label="Type">
						${(control) =>
							html`<${Select}
								options=${options}
								value=${variable.type ?? ''}
								disabled=${disabled}
								onChange=${(type) => update(index, { type, params: structuredClone(varSpec(type)?.defaults ?? {}) })}
								...${control}
							/>`}
					<//>
					<${IconButton}
						label=${`Remove variable ${variable.name || index + 1}`}
						icon="trash"
						disabled=${disabled}
						onClick=${() => onChange(vars.filter((_, i) => i !== index))}
					/>
				</div>
				${known?.help && html`<p class="field__help">${known.help}</p>`}
				${structured
					? html`<${VarParams}
							key=${variable.type}
							variable=${variable}
							disabled=${disabled}
							onValidity=${(valid) => setRawInvalid(`vars.${index}.fields`, !valid)}
							setParams=${(params) => update(index, { params })}
						/>`
					: html`<${RawYamlField}
							key=${`raw-${variable.type}`}
							label="Settings (YAML)"
							help="This variable uses options the form cannot show, so its settings are edited as YAML."
							value=${variable.params}
							disabled=${disabled}
							onValidity=${(valid) => setRawInvalid(`vars.${index}`, !valid)}
							onChange=${(params) => update(index, { params: params ?? {} })}
							check=${(value) => (isMapping(value) ? '' : 'Settings must be a mapping of names to values.')}
						/>`}
			</div>`;
		})}
		${!disabled &&
		html`<div class="add-row">
			<${Select} aria-label="Type of variable to add" options=${typeOptions} value=${newType} onChange=${setNewType} />
			<${Button}
				variant="outline"
				icon="plus"
				onClick=${() =>
					onChange([
						...vars,
						defaultVar(
							newType,
							vars.map((variable) => variable.name)
						),
					])}
			>
				Add variable
			<//>
		</div>`}
	</div>`;
}
