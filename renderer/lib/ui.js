import {
	Component,
	createContext,
	html,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '../vendor/preact-htm.js';
import { Icon } from './icons.js';

// The app's building blocks, in shadcn/ui's shapes: Button, Field, Card,
// Dialog and so on. Styling lives in styles/app.css.

export const cx = (...parts) => parts.filter(Boolean).join(' ');

let idCounter = 0;
export function useId(prefix = 'ui') {
	return useMemo(() => `${prefix}-${(idCounter += 1)}`, [prefix]);
}

export function Button({ variant = 'default', size, icon, children, class: cls, ...props }) {
	const classes = cx('btn', variant !== 'default' && `btn--${variant}`, size && `btn--${size}`, cls);
	return html`<button type="button" class=${classes} ...${props}>
		${icon && html`<${Icon} name=${icon} />`}${children}
	</button>`;
}

// An icon on its own says nothing to a screen reader, so the label is required.
export function IconButton({ label, icon, variant = 'ghost', size, class: cls, ...props }) {
	const classes = cx('btn', 'btn--icon', `btn--${variant}`, size && `btn--${size}`, cls);
	return html`<button type="button" class=${classes} aria-label=${label} title=${label} ...${props}>
		<${Icon} name=${icon} />
	</button>`;
}

export function Field({ label, help, error, children, class: cls }) {
	const id = useId('field');
	const describedBy = cx(help && `${id}-help`, error && `${id}-error`) || undefined;
	// The one child is a function that receives the control's id and ARIA wiring.
	const render = [children].flat().find((child) => typeof child === 'function');
	return html`<div class=${cx('field', cls)}>
		<label class="field__label" for=${id}>${label}</label>
		${render({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? 'true' : undefined })}
		${help && html`<p class="field__help" id=${`${id}-help`}>${help}</p>`}
		${error && html`<p class="field__error" id=${`${id}-error`} role="alert">${error}</p>`}
	</div>`;
}

export function Select({ options, value, onChange, ...props }) {
	return html`<select class="select" value=${value} onChange=${(event) => onChange(event.target.value)} ...${props}>
		${options.map((option) => html`<option value=${option.id} selected=${option.id === value}>${option.label}</option>`)}
	</select>`;
}

export function Switch({ checked, onChange, title, description, disabled }) {
	const id = useId('switch');
	return html`<div class="switch-row">
		<button
			type="button"
			class="switch"
			role="switch"
			aria-checked=${checked ? 'true' : 'false'}
			aria-labelledby=${`${id}-title`}
			aria-describedby=${description ? `${id}-desc` : undefined}
			disabled=${disabled}
			onClick=${() => onChange(!checked)}
		></button>
		<div class="switch-row__text">
			<div class="switch-row__title" id=${`${id}-title`}>${title}</div>
			${description && html`<div class="field__help" id=${`${id}-desc`}>${description}</div>`}
		</div>
	</div>`;
}

export function Segmented({ label, options, value, onChange, icons, disabled }) {
	return html`<div class=${cx('segmented', icons && 'segmented--icons')} role="radiogroup" aria-label=${label}>
		${options.map(
			(option) =>
				html`<button
					type="button"
					role="radio"
					aria-checked=${option.id === value ? 'true' : 'false'}
					aria-label=${icons ? option.label : undefined}
					title=${icons ? option.label : undefined}
					disabled=${disabled}
					onClick=${() => onChange(option.id)}
				>
					${option.icon && html`<${Icon} name=${option.icon} />`}${!icons && option.label}
				</button>`
		)}
	</div>`;
}

export function Card({ title, description, actions, children, class: cls }) {
	return html`<section class=${cx('card', cls)}>
		${title &&
		html`<div class="card__head">
			<h2 class="card__title">${title}</h2>
			<span class="spacer"></span>
			${actions}
		</div>`}
		${description && html`<p class="card__desc">${description}</p>`}
		<div class="card__body">${children}</div>
	</section>`;
}

export function Badge({ tone, icon, children }) {
	return html`<span class=${cx('badge', tone && `badge--${tone}`)}>${icon && html`<${Icon} name=${icon} />`}${children}</span>`;
}

export function Alert({ tone = 'info', icon = 'info', title, children, actions }) {
	return html`<div class=${cx('alert', tone !== 'info' && `alert--${tone}`)} role=${tone === 'danger' ? 'alert' : 'status'}>
		<${Icon} name=${icon} />
		<div class="alert__body">
			${title && html`<div class="alert__title">${title}</div>`}
			${children}
			${actions && html`<div class="alert__actions">${actions}</div>`}
		</div>
	</div>`;
}

export function Empty({ icon, title, children, actions }) {
	return html`<div class="empty">
		<div class="empty__icon"><${Icon} name=${icon} /></div>
		<h2>${title}</h2>
		<p>${children}</p>
		${actions && html`<div class="empty__actions">${actions}</div>`}
	</div>`;
}

// A list of text values with add and remove, used for triggers and choices.
export function Repeater({ label, values, onChange, placeholder, addLabel, mono, disabled, minRows = 0 }) {
	const rows = values.length >= minRows ? values : [...values, ...Array(minRows - values.length).fill('')];
	const update = (index, value) => onChange(rows.map((row, i) => (i === index ? value : row)));
	return html`<div class="repeater">
		${rows.map(
			(value, index) =>
				html`<div class="repeater__row">
					<input
						class=${cx('input', mono && 'mono')}
						value=${value}
						placeholder=${placeholder}
						aria-label=${`${label} ${index + 1}`}
						disabled=${disabled}
						onInput=${(event) => update(index, event.target.value)}
					/>
					<${IconButton}
						label=${`Remove ${label.toLowerCase()} ${index + 1}`}
						icon="x"
						disabled=${disabled || rows.length <= minRows}
						onClick=${() => onChange(rows.filter((_, i) => i !== index))}
					/>
				</div>`
		)}
		<div>
			<${Button} variant="outline" size="sm" icon="plus" disabled=${disabled} onClick=${() => onChange([...rows, ''])}>
				${addLabel}
			<//>
		</div>
	</div>`;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]';

// Shared behaviour for anything modal: Escape closes, Tab stays inside, and
// focus goes back to where it came from on close.
export function Overlay({ onClose, children, label }) {
	const ref = useRef(null);
	useEffect(() => {
		const previous = document.activeElement;
		const panel = ref.current;
		(panel.querySelector('[data-autofocus]') ?? panel.querySelector(FOCUSABLE))?.focus();
		const onKey = (event) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				onClose();
			} else if (event.key === 'Tab') {
				const items = [...panel.querySelectorAll(FOCUSABLE)];
				if (!items.length) return;
				const first = items[0];
				const last = items[items.length - 1];
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first.focus();
				}
			}
		};
		panel.addEventListener('keydown', onKey);
		return () => {
			panel.removeEventListener('keydown', onKey);
			if (previous instanceof HTMLElement) previous.focus();
		};
	}, []);
	return html`<div
		class="overlay"
		onMouseDown=${(event) => {
			if (event.target === event.currentTarget) onClose();
		}}
	>
		<div ref=${ref} role="dialog" aria-modal="true" aria-label=${label}>${children}</div>
	</div>`;
}

export function Dialog({ title, description, onClose, children, footer }) {
	return html`<${Overlay} onClose=${onClose} label=${title}>
		<div class="dialog">
			<div class="dialog__head">
				<h2>${title}</h2>
				${description && html`<p>${description}</p>`}
			</div>
			${children && html`<div class="dialog__body">${children}</div>`}
			<div class="dialog__foot">${footer}</div>
		</div>
	<//>`;
}

export function ConfirmDialog({ title, description, confirmLabel, cancelLabel = 'Cancel', destructive, onConfirm, onClose }) {
	return html`<${Dialog}
		title=${title}
		description=${description}
		onClose=${onClose}
		footer=${html`
			<${Button} variant="outline" onClick=${onClose} data-autofocus>${cancelLabel}<//>
			<${Button} variant=${destructive ? 'destructive' : 'default'} onClick=${onConfirm}>${confirmLabel}<//>
		`}
	/>`;
}

// --- toasts -----------------------------------------------------------------

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
	const [toasts, setToasts] = useState([]);
	const toast = useCallback(({ title, description, tone = 'success' }) => {
		const id = (idCounter += 1);
		setToasts((list) => [...list.slice(-2), { id, title, description, tone }]);
		setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), tone === 'error' ? 7000 : 3500);
	}, []);
	return html`<${ToastContext.Provider} value=${toast}>
		${children}
		<div class="toasts" role="status" aria-live="polite">
			${toasts.map(
				(item) =>
					html`<div class=${cx('toast', item.tone === 'error' && 'toast--error')} key=${item.id}>
						<${Icon} name=${item.tone === 'error' ? 'alert' : 'check'} />
						<div>
							<div class="toast__title">${item.title}</div>
							${item.description && html`<div class="toast__desc">${item.description}</div>`}
						</div>
					</div>`
			)}
		</div>
	<//>`;
}

// --- errors -----------------------------------------------------------------

// Catches a failure while drawing what is inside it and shows `fallback`
// instead, so one screen that cannot be drawn does not blank the window.
export class ErrorBoundary extends Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}

	componentDidCatch(error) {
		this.setState({ error });
	}

	render() {
		return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
	}
}
