import { html, useRef, useState } from '../vendor/preact-htm.js';
import { Icon } from '../lib/icons.js';
import { IconButton, Segmented, cx } from '../lib/ui.js';

const THEME_OPTIONS = [
	{ id: 'system', label: 'Match system', icon: 'monitor' },
	{ id: 'light', label: 'Light', icon: 'sun' },
	{ id: 'dark', label: 'Dark', icon: 'moon' },
];

function Section({ label, count, action, children }) {
	const [open, setOpen] = useState(true);
	return html`<div class="nav-section">
		<div class="nav-section__head">
			<button class="nav-section__toggle" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>
				<${Icon} name="chevron-right" />
				<span>${label}</span>
				<span class="nav-section__count">${count}</span>
			</button>
			${action}
		</div>
		${open && html`<ul>${children}</ul>`}
	</div>`;
}

function FileItem({ file, route, navigate, nested }) {
	const current = (route.view === 'file' || route.view === 'snippet') && route.fileId === file.id;
	const title = file.importOnly ? `${file.name} is loaded only when another file imports it` : file.description || file.name;
	return html`<li>
		<button
			class=${cx('nav-item', nested ? 'nav-item--nested' : 'nav-item--file', file.importOnly && 'nav-item--dim')}
			aria-current=${current ? 'page' : undefined}
			title=${title}
			onClick=${() => navigate({ view: 'file', fileId: file.id })}
		>
			${file.prefix && html`<span class="chip chip--prefix">${file.prefix}</span>`}
			<span class="nav-item__label truncate">${file.name}</span>
			${file.matchCount === null
				? html`<span class="nav-error" aria-label="Has YAML errors">!</span>`
				: html`<span class="nav-count">${file.matchCount}</span>`}
		</button>
	</li>`;
}

function PackageItem({ pkg, route, navigate }) {
	const [open, setOpen] = useState(true);
	return html`<li>
		<button class="nav-item nav-item--file" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)} title=${pkg.description || pkg.title}>
			<span class="active-dot" aria-hidden="true"></span>
			<span class="nav-item__label truncate">${pkg.title}</span>
			<span class="nav-count">${pkg.matchCount}</span>
		</button>
		${open && html`<ul>${pkg.files.map((file) => html`<${FileItem} file=${file} route=${route} navigate=${navigate} nested />`)}</ul>`}
	</li>`;
}

export function Sidebar({ state, route, navigate, theme, setTheme, width, setWidth, onNewFile, snippetCount }) {
	const [dragging, setDragging] = useState(false);
	const start = useRef(null);

	const onPointerDown = (event) => {
		start.current = { x: event.clientX, width };
		event.currentTarget.setPointerCapture(event.pointerId);
		setDragging(true);
	};
	const onPointerMove = (event) => {
		if (!dragging) return;
		setWidth(start.current.width + event.clientX - start.current.x);
	};
	const onKeyDown = (event) => {
		if (event.key === 'ArrowLeft') setWidth(width - 16);
		if (event.key === 'ArrowRight') setWidth(width + 16);
	};

	const item = (view, icon, label, count) => html`<li>
		<button class="nav-item" aria-current=${route.view === view ? 'page' : undefined} onClick=${() => navigate({ view })}>
			<${Icon} name=${icon} />
			<span class="nav-item__label">${label}</span>
			${count !== undefined && html`<span class="nav-count">${count}</span>`}
		</button>
	</li>`;

	return html`<aside class="sidebar" aria-label="Sources">
		<div class="sidebar__brand">
			<span class="brand-mark"><${Icon} name="prompt" /></span>
			<span>Snippet Editor</span>
		</div>
		<nav class="sidebar__scroll" aria-label="Main">
			<ul>
				${item('overview', 'overview', 'Overview')} ${item('all', 'list', 'All snippets', snippetCount)} ${item('team', 'team', 'Team packages')}
			</ul>
			<${Section}
				label="Local"
				count=${state.files.length}
				action=${html`<${IconButton} label="New file" icon="plus" size="sm" onClick=${onNewFile} />`}
			>
				${state.files.map((file) => html`<${FileItem} file=${file} route=${route} navigate=${navigate} />`)}
				${!state.files.length && html`<li class="nav-empty">No match files yet.</li>`}
			<//>
			<${Section} label="Packages" count=${state.packages.length}>
				${state.packages.map((pkg) => html`<${PackageItem} pkg=${pkg} route=${route} navigate=${navigate} />`)}
				${!state.packages.length && html`<li class="nav-empty">No packages installed.</li>`}
			<//>
			${state.team.length > 0 &&
			html`<${Section} label="Team" count=${state.team.length}>
				${state.team.map((pkg) => html`<${PackageItem} pkg=${pkg} route=${route} navigate=${navigate} />`)}
			<//>`}
		</nav>
		<div class="sidebar__footer">
			<button class="nav-item" aria-current=${route.view === 'settings' ? 'page' : undefined} onClick=${() => navigate({ view: 'settings' })}>
				<${Icon} name="settings" />
				<span class="nav-item__label">Settings</span>
			</button>
			<${Segmented} label="Theme" icons options=${THEME_OPTIONS} value=${theme} onChange=${setTheme} />
		</div>
		<button
			class="sidebar__resize"
			aria-label="Resize sidebar. Use the left and right arrow keys."
			data-dragging=${dragging ? '' : undefined}
			onPointerDown=${onPointerDown}
			onPointerMove=${onPointerMove}
			onPointerUp=${() => setDragging(false)}
			onKeyDown=${onKeyDown}
		></button>
	</aside>`;
}
