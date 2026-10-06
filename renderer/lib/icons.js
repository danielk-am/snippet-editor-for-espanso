import { html } from '../vendor/preact-htm.js';

// A small set of line icons on a 24px grid, after Lucide.
const PATHS = {
	search: html`<circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />`,
	plus: html`<path d="M5 12h14" /><path d="M12 5v14" />`,
	x: html`<path d="M18 6 6 18" /><path d="m6 6 12 12" />`,
	check: html`<path d="M20 6 9 17l-5-5" />`,
	'chevron-right': html`<path d="m9 18 6-6-6-6" />`,
	'arrow-left': html`<path d="m12 19-7-7 7-7" /><path d="M19 12H5" />`,
	copy: html`<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path
			d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
		/>`,
	trash: html`<path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path
			d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"
		/><path d="M10 11v6" /><path d="M14 11v6" />`,
	file: html`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path
			d="M14 2v4a2 2 0 0 0 2 2h4"
		/><path d="M16 13H8" /><path d="M16 17H8" />`,
	package: html`<path
			d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"
		/><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" />`,
	settings: html`<path d="M21 4h-7" /><path d="M10 4H3" /><path d="M21 12h-9" /><path d="M8 12H3" /><path
			d="M21 20h-5"
		/><path d="M12 20H3" /><path d="M14 2v4" /><path d="M8 10v4" /><path d="M16 18v4" />`,
	overview: html`<rect width="7" height="9" x="3" y="3" rx="1" /><rect width="7" height="5" x="14" y="3" rx="1" /><rect
			width="7"
			height="9"
			x="14"
			y="12"
			rx="1"
		/><rect width="7" height="5" x="3" y="16" rx="1" />`,
	list: html`<path d="M3 12h.01" /><path d="M3 18h.01" /><path d="M3 6h.01" /><path d="M8 12h13" /><path
			d="M8 18h13"
		/><path d="M8 6h13" />`,
	alert: html`<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path
			d="M12 9v4"
		/><path d="M12 17h.01" />`,
	info: html`<circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />`,
	sidebar: html`<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" />`,
	sun: html`<circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path
			d="m4.93 4.93 1.41 1.41"
		/><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path
			d="m6.34 17.66-1.41 1.41"
		/><path d="m19.07 4.93-1.41 1.41" />`,
	moon: html`<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />`,
	monitor: html`<rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" />`,
	folder: html`<path
			d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
		/>`,
	code: html`<path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" />`,
	pencil: html`<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" />`,
	lock: html`<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />`,
	refresh: html`<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path
			d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"
		/><path d="M8 16H3v5" />`,
	enter: html`<path d="m9 10-5 5 5 5" /><path d="M20 4v7a4 4 0 0 1-4 4H4" />`,
	prompt: html`<path d="m7 8 4 4-4 4" /><path d="M13 16h4" />`,
};

export function Icon({ name, class: cls }) {
	return html`<svg class=${cls ? `icon ${cls}` : 'icon'} viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`;
}
