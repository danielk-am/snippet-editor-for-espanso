import { html, useState } from '../vendor/preact-htm.js';
import { searchFiles } from '../../shared/search.js';
import { allFiles } from '../lib/api.js';
import { Button, Empty } from '../lib/ui.js';
import { SnippetList, rowsOf } from './SnippetList.js';

const toRows = (files, hits) => hits.map((hit) => ({ file: files.find((file) => file.id === hit.fileId), index: hit.index, match: hit.match }));

// "All snippets" and search results are the same screen: every snippet,
// narrowed by a query, grouped by where it comes from.
export function SearchResults({ state, query, navigate, onNewSnippet }) {
	const [text, setText] = useState(query ?? '');
	const files = allFiles(state);
	const active = text.trim();
	const rows = active ? toRows(files, searchFiles(files, active, { limit: 500 })) : files.flatMap(rowsOf);
	const local = rows.filter((row) => row.file.source === 'local');
	const packaged = rows.filter((row) => row.file.source === 'package');
	const shared = rows.filter((row) => row.file.source === 'team');
	const open = (file, index) => navigate({ view: 'snippet', fileId: file.id, index });

	return html`<div class="page">
		<div class="page-head">
			<div class="page-head__text">
				<h1>All snippets</h1>
				<p>${active ? `${rows.length} matching “${active}”` : `${rows.length} across your files and packages`}</p>
			</div>
			<div class="page-head__actions">
				<${Button} icon="plus" onClick=${() => onNewSnippet()}>New snippet<//>
			</div>
		</div>
		<div class="toolbar">
			<input
				class="input"
				type="search"
				placeholder="Search triggers, labels and text"
				aria-label="Search all snippets"
				value=${text}
				onInput=${(event) => setText(event.target.value)}
			/>
		</div>
		${!rows.length &&
		html`<${Empty} icon="search" title=${active ? 'No snippets match' : 'No snippets yet'}>
			${active ? 'Search looks at triggers, labels, search terms and the expansion text.' : 'Create a file, then add your first snippet to it.'}
		<//>`}
		${local.length > 0 && html`<h2 class="section-title">Local (${local.length})</h2><${SnippetList} rows=${local} showFile onOpen=${open} />`}
		${packaged.length > 0 && html`<h2 class="section-title">Packages (${packaged.length})</h2><${SnippetList} rows=${packaged} showFile onOpen=${open} />`}
		${shared.length > 0 && html`<h2 class="section-title">Team (${shared.length})</h2><${SnippetList} rows=${shared} showFile onOpen=${open} />`}
	</div>`;
}
