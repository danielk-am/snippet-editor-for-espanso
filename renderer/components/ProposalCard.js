import { html, useMemo, useState } from '../vendor/preact-htm.js';
import { diffLines } from '../lib/diff.js';
import { Icon } from '../lib/icons.js';
import { Badge, Button } from '../lib/ui.js';

// One change the assistant proposed. Nothing is written until Apply.

const ICONS = { add: 'plus', update: 'pencil', delete: 'trash', 'create-file': 'file', 'replace-file': 'code', install: 'download', send: 'pull-request' };
const SHOWN = 14;
// Opened up, a card still shows only so much. The file itself shows the rest.
const MOST = 400;
const SIGN = { add: '+', remove: '−', same: ' ' };

function Lines({ rows }) {
	const [all, setAll] = useState(false);
	const visible = rows.slice(0, all ? MOST : SHOWN);
	return html`<div class="proposal__diff">
		<div class="proposal__rows" role="group" aria-label="What would change">
			${visible.map((row) =>
				row.kind === 'skip'
					? html`<div class="diff-row diff-row--skip">${row.count} unchanged ${row.count === 1 ? 'line' : 'lines'}</div>`
					: row.kind === 'note'
						? html`<div class="diff-row diff-row--skip">${row.text}</div>`
						: html`<div class=${`diff-row diff-row--${row.kind}`}>
								<span class="diff-row__sign" aria-label=${row.kind === 'add' ? 'Added' : row.kind === 'remove' ? 'Removed' : undefined}>${SIGN[row.kind]}</span
								><span class="diff-row__text">${row.text || ' '}</span>
							</div>`
			)}
		</div>
		${all && rows.length > MOST && html`<p class="proposal__note">${(rows.length - MOST).toLocaleString('en-US')} more lines are not shown here.</p>`}
		${rows.length > SHOWN && html`<button class="link proposal__more" onClick=${() => setAll(!all)}>${all ? 'Show less' : `Show ${rows.length > MOST ? `the first ${MOST} of ${rows.length.toLocaleString('en-US')}` : `all ${rows.length}`} lines`}</button>`}
	</div>`;
}

const STATE = {
	applied: ['success', 'check', 'Applied'],
	stale: ['danger', 'alert', 'Not applied'],
	dismissed: [undefined, undefined, 'Dismissed'],
	expired: [undefined, undefined, 'Expired'],
};

export function ProposalCard({ card, blocked, onApply, onDismiss, onShow, onOpenSettings, onOpenLink }) {
	// What is sent to the team is shown whole. The rest shows what differs.
	const rows = useMemo(() => {
		if (card.before === null && card.after === null) return [];
		return diffLines(card.before, card.after, { context: card.kind === 'send' ? 0 : 2 });
	}, [card.before, card.after, card.kind]);
	const waiting = card.status === 'pending' || card.status === 'applying';
	const state = STATE[card.status];

	return html`<section class="proposal" data-status=${card.status} aria-label=${card.title}>
		<div class="proposal__head">
			<span class="proposal__icon"><${Icon} name=${ICONS[card.kind] ?? 'pencil'} /></span>
			<div class="proposal__titles">
				<div class="proposal__title">${card.title}</div>
				${card.subject && card.subject !== card.fileName && html`<div class="proposal__subject truncate">${card.subject}</div>`}
			</div>
			${state && html`<${Badge} tone=${state[0]} icon=${state[1]}>${state[2]}<//>`}
		</div>
		${card.lines.length > 0 && html`<ul class="proposal__facts">${card.lines.map((line) => html`<li>${line}</li>`)}</ul>`}
		${rows.length > 0 && html`<${Lines} rows=${rows} />`}
		${waiting && card.warnings.map((warning) => html`<p class="proposal__warning"><${Icon} name="alert" /><span>${warning}</span></p>`)}
		${card.message && html`<p class=${card.status === 'applied' ? 'proposal__note' : 'proposal__problem'} role=${card.status === 'applied' ? 'status' : 'alert'}>${card.message}</p>`}
		${card.status === 'expired' && html`<p class="proposal__note">The app was closed before this was applied. Ask again if you still want it.</p>`}
		${waiting && blocked && html`<p class="proposal__problem" role="status">${blocked}</p>`}
		<div class="proposal__actions">
			${waiting &&
			html`
				<${Button} size="sm" icon="check" disabled=${card.status === 'applying'} onClick=${onApply}>${card.status === 'applying' ? 'Applying…' : 'Apply'}<//>
				<${Button} size="sm" variant="ghost" disabled=${card.status === 'applying'} onClick=${onDismiss}>Dismiss<//>
			`}
			${waiting && card.code === 'SWITCH_OFF' && html`<${Button} size="sm" variant="outline" icon="settings" onClick=${onOpenSettings}>Open Settings<//>`}
			${card.status === 'applied' && card.link && html`<${Button} size="sm" variant="outline" icon="pull-request" onClick=${onOpenLink}>Open the pull request page<//>`}
			${card.status === 'applied' && card.fileId && card.kind !== 'send' && html`<${Button} size="sm" variant="ghost" icon="file" onClick=${onShow}>Show the file<//>`}
		</div>
	</section>`;
}
