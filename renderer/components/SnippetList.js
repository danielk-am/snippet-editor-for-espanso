import { html } from '../vendor/preact-htm.js';
import { contentTypeOf, matchTriggers, previewText } from '../../shared/snippetModel.js';
import { toText } from '../../shared/text.js';
import { Badge, IconButton, cx, useToast } from '../lib/ui.js';
import { api } from '../lib/api.js';

const TYPE_LABELS = { markdown: 'Markdown', html: 'HTML', form: 'Form', image_path: 'Image' };

// One row per snippet. Opening the row edits it; the trailing button copies
// the trigger, which is what you want when telling someone what to type.
export function SnippetList({ rows, showFile, onOpen }) {
	const toast = useToast();
	const copy = async (text) => {
		await api.copy(text);
		toast({ title: 'Trigger copied', description: text });
	};

	return html`<ul class="snippet-list">
		${rows.map(({ file, index, match }) => {
			const triggers = matchTriggers(match);
			const type = contentTypeOf(match);
			const preview = previewText(match);
			const label = toText(match.label);
			return html`<li class="snippet-row" key=${`${file.id}#${index}`}>
				<button class="snippet-row__open" onClick=${() => onOpen(file, index)}>
					<span class="snippet-row__triggers">
						${triggers.map((trigger) => html`<span class=${cx('chip', match.regex !== undefined && 'chip--regex')}>${trigger}</span>`)}
						${!triggers.length && html`<span class="muted">No trigger</span>`}
					</span>
					<span class="snippet-row__text">
						${label && html`<span class="snippet-row__label truncate">${label}</span>`}
						<span class="snippet-row__preview truncate">${preview || 'Empty'}</span>
					</span>
					<span class="snippet-row__meta">
						${TYPE_LABELS[type] && html`<${Badge}>${TYPE_LABELS[type]}<//>`}
						${Array.isArray(match.vars) && match.vars.length > 0 && html`<${Badge}>Variables<//>`}
						${showFile && html`<${Badge} tone=${file.source === 'local' ? 'accent' : undefined} icon=${file.source === 'local' ? 'file' : file.source === 'team' ? 'team' : 'package'}>
							${file.source === 'local' ? file.name : file.package}
						<//>`}
					</span>
				</button>
				${triggers[0] &&
				html`<span class="snippet-row__actions">
					<${IconButton} label=${`Copy trigger ${triggers[0]}`} icon="copy" size="sm" onClick=${() => copy(triggers[0])} />
				</span>`}
			</li>`;
		})}
	</ul>`;
}

export const rowsOf = (file) => (file.matches ?? []).map((match, index) => ({ file, index, match }));
