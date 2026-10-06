import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { matchTriggers, previewText } from '../../shared/snippetModel.js';
import { searchFiles } from '../../shared/search.js';
import { toText } from '../../shared/text.js';
import { allFiles } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { Overlay } from '../lib/ui.js';

export function CommandPalette({ state, actions, navigate, onClose }) {
	const [query, setQuery] = useState('');
	const [selected, setSelected] = useState(0);
	const list = useRef(null);
	const files = allFiles(state);
	const needle = query.trim().toLowerCase();

	const groups = [];
	if (needle) {
		const hits = searchFiles(files, needle, { limit: 8 });
		if (hits.length) {
			groups.push({
				label: 'Snippets',
				items: hits.map((hit) => ({
					icon: hit.source === 'package' ? 'package' : 'prompt',
					label: matchTriggers(hit.match).join('  ') || 'No trigger',
					mono: true,
					hint: toText(hit.match.label) || previewText(hit.match, 60),
					run: () => navigate({ view: 'snippet', fileId: hit.fileId, index: hit.index }),
				})),
			});
		}
		const fileHits = files.filter((file) => file.name.toLowerCase().includes(needle)).slice(0, 5);
		if (fileHits.length) {
			groups.push({
				label: 'Files',
				items: fileHits.map((file) => ({
					icon: file.source === 'package' ? 'package' : 'file',
					label: file.name,
					hint: file.source === 'package' ? file.package : file.description,
					run: () => navigate({ view: 'file', fileId: file.id }),
				})),
			});
		}
	}
	const matching = actions.filter((action) => !needle || action.label.toLowerCase().includes(needle));
	if (matching.length) groups.push({ label: 'Actions', items: matching });
	if (needle) {
		groups.push({
			label: 'Search',
			items: [{ icon: 'search', label: `Show all results for “${query.trim()}”`, run: () => navigate({ view: 'all', query: query.trim() }) }],
		});
	}

	const items = groups.flatMap((group) => group.items);
	const active = Math.min(selected, items.length - 1);

	useEffect(() => {
		list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [active, query]);

	const run = (item) => {
		onClose();
		item.run();
	};

	const onKeyDown = (event) => {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setSelected((active + 1) % items.length);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			setSelected((active - 1 + items.length) % items.length);
		} else if (event.key === 'Enter' && items[active]) {
			event.preventDefault();
			run(items[active]);
		}
	};

	let position = -1;
	return html`<${Overlay} onClose=${onClose} label="Search and commands">
		<div class="palette">
			<div class="palette__input">
				<${Icon} name="search" />
				<input
					data-autofocus
					role="combobox"
					aria-expanded="true"
					aria-controls="palette-list"
					aria-label="Search snippets, files and actions"
					placeholder="Search snippets, files and actions"
					value=${query}
					onInput=${(event) => {
						setQuery(event.target.value);
						setSelected(0);
					}}
					onKeyDown=${onKeyDown}
				/>
			</div>
			<div class="palette__list" id="palette-list" role="listbox" ref=${list}>
				${groups.map(
					(group) => html`
						<div class="palette__group" role="presentation">${group.label}</div>
						${group.items.map((item) => {
							position += 1;
							const at = position;
							return html`<button class="palette__item" role="option" tabindex="-1" aria-selected=${at === active ? 'true' : 'false'} onMouseMove=${() => setSelected(at)} onClick=${() => run(item)}>
								<${Icon} name=${item.icon} />
								<span class=${item.mono ? 'mono' : undefined}>${item.label}</span>
								<span class="muted truncate">${item.hint}</span>
							</button>`;
						})}
					`
				)}
				${!items.length && html`<div class="palette__empty">Nothing matches “${query.trim()}”.</div>`}
			</div>
			<div class="palette__legend" aria-hidden="true">
				<span><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> to move</span>
				<span><kbd class="kbd">↵</kbd> to open</span>
				<span><kbd class="kbd">esc</kbd> to close</span>
			</div>
		</div>
	<//>`;
}
