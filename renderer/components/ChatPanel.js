import { html, useCallback, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { api } from '../lib/api.js';
import { chatInitial, saveChat } from '../lib/chatSession.js';
import { whereNow } from '../../shared/found.js';
import { titleOf, toldKey } from '../lib/chatStore.js';
import { Icon } from '../lib/icons.js';
import { Alert, Badge, Button, IconButton, Select } from '../lib/ui.js';
import { Markdown } from './Markdown.js';
import { ProposalCard } from './ProposalCard.js';

// The assistant: a panel on the right, where you ask in plain words and it
// finds, explains and drafts snippets. It changes nothing itself. A change
// arrives as a card, and is written when you press Apply. The snippets
// closest to a message are listed the moment it is sent: that is the app's
// own search, and it does not wait for the assistant.

export const CHAT_MIN = 320;
export const CHAT_MAX = 720;
const STEP = 16;

// What a tool is doing, and what it did.
const TOOL_WORDS = {
	snippets_search: ['Searching snippets', 'Searched snippets'],
	snippets_list_files: ['Listing files', 'Listed files'],
	snippets_get_file: ['Reading a file', 'Read a file'],
	snippets_get_snippet: ['Reading a snippet', 'Read a snippet'],
	snippets_list_team_packages: ['Looking at team packages', 'Looked at team packages'],
	snippets_add_snippet: ['Proposing a snippet', 'Proposed a snippet'],
	snippets_update_snippet: ['Proposing a change', 'Proposed a change'],
	snippets_delete_snippet: ['Proposing a deletion', 'Proposed a deletion'],
	snippets_create_file: ['Proposing a file', 'Proposed a file'],
	snippets_replace_file_yaml: ['Proposing new text for a file', 'Proposed new text for a file'],
	snippets_install_team_package: ['Proposing an install', 'Proposed an install'],
	snippets_propose_to_team: ['Proposing to send a file', 'Proposed sending a file'],
};

// How many of the closest matches are listed before "Show all".
const FIRST_MATCHES = 3;
// What a backend that is not on this computer is sent.
const SENT = 'your messages, the snippets that match them, what you have open, and the snippets it reads';

const STATE_WORDS = { ready: 'Ready', missing: 'Not installed', 'signed-out': 'Not signed in', 'not-running': 'Not running', 'no-models': 'No models', old: 'Too old' };

// What the assistant is told happened to a card it made, next time it is asked.
const CARD_WORDS = {
	pending: 'Not applied yet.',
	applying: 'Not applied yet.',
	applied: 'Applied by the person.',
	stale: 'Not applied: the file had changed.',
	dismissed: 'Dismissed by the person.',
	expired: 'Not applied.',
};

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// The line under an answer that says what was looked at: "Searched snippets · Read a file ×2".
function toolLine(tools) {
	const counts = new Map();
	for (const tool of tools) {
		const words = TOOL_WORDS[tool.name] ?? ['Using a tool', 'Used a tool'];
		const text = tool.status === 'started' ? `${words[0]}…` : tool.status === 'failed' ? `${words[1]} (did not work)` : words[1];
		counts.set(text, (counts.get(text) ?? 0) + 1);
	}
	return [...counts].map(([text, count]) => (count > 1 ? `${text} ×${count}` : text)).join(' · ');
}

function forModel(message) {
	if (message.role === 'user') return { role: 'user', text: message.text };
	const cards = message.cards.map((card) => `[Card shown to the person: ${card.title}. ${CARD_WORDS[card.status] ?? 'Not applied.'}]`).join('\n');
	const text = [message.text.trim(), cards].filter(Boolean).join('\n\n');
	return text ? { role: 'assistant', text } : null;
}

// An answer in the order it was given: its text, with each card where the
// assistant proposed it.
function pieces(message) {
	const parts = [];
	let from = 0;
	for (const card of message.cards) {
		const at = Number.isInteger(card.at) ? Math.min(Math.max(card.at, from), message.text.length) : message.text.length;
		const text = message.text.slice(from, at).trim();
		if (text) parts.push({ text });
		parts.push({ card });
		from = at;
	}
	const rest = message.text.slice(from).trim();
	if (rest) parts.push({ text: rest });
	return parts;
}

const when = (time) => {
	if (!time) return '';
	const date = new Date(time);
	const today = new Date().toDateString() === date.toDateString();
	return today ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

const STARTERS = [
	{ label: 'Find a snippet', fill: 'Find my snippet about ' },
	{ label: 'Draft a new snippet', fill: 'Draft a snippet that ' },
	{ label: 'Tidy the snippet I have open', send: 'Tidy the snippet I have open: fix typos and wording, and keep its meaning.', needs: 'snippet' },
	{ label: 'Explain this file', send: 'Explain what this file is for and how its snippets are organised.', needs: 'file' },
];

// --- the closest matches --------------------------------------------------------------------

function Found({ hits, onOpen }) {
	const [all, setAll] = useState(false);
	const shown = all ? hits : hits.slice(0, FIRST_MATCHES);
	return html`<section class="found" aria-label="Closest matches">
		<h3 class="found__title">Closest matches</h3>
		<ul class="found__list">
			${shown.map(
				(hit) => html`<li key=${`${hit.fileId}#${hit.index}`}>
					<button class="found__row" title="Open this snippet" onClick=${() => onOpen(hit)}>
						<span class="found__triggers mono truncate">${hit.triggers.join('  ') || 'No trigger'}</span>
						<span class="found__file truncate">${hit.package ? `${hit.package} · ${hit.fileName}` : hit.fileName}</span>
						<span class="found__preview truncate">${hit.label || hit.preview || 'No text'}</span>
					</button>
				</li>`
			)}
		</ul>
		${hits.length > FIRST_MATCHES &&
		html`<button class="found__more" aria-expanded=${all ? 'true' : 'false'} onClick=${() => setAll(!all)}>${all ? 'Show fewer' : `Show all ${hits.length}`}</button>`}
	</section>`;
}

// --- who answers ----------------------------------------------------------------------------

function Backends({ status, chosen, wanted, model, checking, onChoose, onModel, onCheck }) {
	const lead = chosen
		? 'Choose who answers.'
		: wanted
			? `${wanted.label} is not ready. Fix it and press Check again, or choose another.`
			: 'The assistant answers through one of these. None is ready yet.';
	return html`<div class="chat__setup">
		<p class="chat__lead">${lead}</p>
		<ul class="backends">
			${status.map(
				(backend) => html`<li class="backend" data-ready=${backend.ready ? '' : undefined}>
					<label class="backend__row">
						<input class="backend__radio" type="radio" name="chat-backend" checked=${chosen?.id === backend.id} disabled=${!backend.ready} onChange=${() => onChoose(backend.id)} />
						<span class="backend__mark" aria-hidden="true"></span>
						<span class="backend__name">${backend.label}</span>
						<${Badge} tone=${backend.ready ? 'success' : undefined}>${STATE_WORDS[backend.state] ?? backend.state}<//>
					</label>
					${backend.message && html`<p class="backend__message">${backend.message}</p>`}
					${backend.command &&
					html`<div class="backend__command">
						<code>${backend.command}</code>
						<${Button} size="sm" variant="outline" icon="copy" onClick=${() => api.copy(backend.command)}>Copy<//>
					</div>`}
					${backend.id === 'ollama' &&
					backend.ready &&
					html`<label class="backend__model">
						<span>Model</span>
						<${Select} value=${model?.name ?? ''} onChange=${onModel} options=${backend.models.map((item) => ({ id: item.name, label: item.name }))} />
					</label>`}
					<p class="backend__sends">
						${backend.id === 'ollama'
							? 'Local models stay on this computer. With a cloud model, your messages, the snippets that match them, what you have open, and the snippets it reads go to Ollama.'
							: `Sends ${SENT}, to ${backend.sendsTo}, under your own sign-in.`}
					</p>
				</li>`
			)}
		</ul>
		<${Button} variant="outline" icon="refresh" disabled=${checking} onClick=${onCheck}>${checking ? 'Checking…' : 'Check again'}<//>
	</div>`;
}

// --- the panel ------------------------------------------------------------------------------

export function ChatPanel({ open, sheet, prefs, setPrefs, context, files, isDirty, refresh, navigate, onClose }) {
	const [conversations, setConversations] = useState(chatInitial.conversations);
	const [currentId, setCurrentId] = useState(chatInitial.current);
	const [view, setView] = useState('chat');
	const [status, setStatus] = useState(null);
	const [checking, setChecking] = useState(false);
	const [draft, setDraft] = useState('');
	const [working, setWorking] = useState(false);
	const [notice, setNotice] = useState(null);
	const [menu, setMenu] = useState(false);
	const [held, setHeld] = useState(null);
	const [clearing, setClearing] = useState(false);
	const [dragging, setDragging] = useState(false);

	const turn = useRef(null);
	const waitingText = useRef('');
	const frame = useRef(0);
	const log = useRef(null);
	const box = useRef(null);
	const drag = useRef(null);
	const pinned = useRef(true);
	const bottom = useRef(0);
	const menuButton = useRef(null);

	const conversation = conversations.find((item) => item.id === currentId) ?? null;

	// --- keeping it ---------------------------------------------------------

	const latest = useRef(null);
	latest.current = { prefs, conversations, current: currentId };
	useEffect(() => {
		const timer = setTimeout(() => saveChat(latest.current), 400);
		return () => clearTimeout(timer);
	}, [prefs, conversations, currentId]);
	// A window that is closing or reloading saves what it has at once.
	useEffect(() => {
		const save = () => saveChat(latest.current);
		window.addEventListener('pagehide', save);
		return () => window.removeEventListener('pagehide', save);
	}, []);

	// --- who answers --------------------------------------------------------

	const check = useCallback(async () => {
		setChecking(true);
		try {
			setStatus(await api.chatStatus());
		} catch {
			setStatus([]);
		} finally {
			setChecking(false);
		}
	}, []);
	useEffect(() => {
		if (open && status === null) check();
	}, [open]);

	const ready = (status ?? []).filter((backend) => backend.ready);
	// The one the person chose, or, before any was chosen, the first that is
	// ready. A chosen one that is not ready is never quietly swapped for
	// another: a message would then go somewhere the person did not pick.
	const wanted = (status ?? []).find((backend) => backend.id === prefs.backend) ?? null;
	const chosen = wanted ? (wanted.ready ? wanted : null) : (ready[0] ?? null);
	// With no model chosen, one that stays on this computer comes first.
	const model = chosen?.id === 'ollama' ? (chosen.models.find((item) => item.name === prefs.model) ?? chosen.models.find((item) => !item.cloud) ?? chosen.models[0]) : null;
	const sendsTo = !chosen ? null : chosen.id === 'ollama' ? (model?.cloud ? 'Ollama' : null) : chosen.sendsTo;
	const mustTell = Boolean(sendsTo) && !prefs.told.includes(toldKey(chosen.id));
	const provider = chosen ? (model ? `Ollama · ${model.name}` : chosen.label) : status === null ? 'Checking…' : 'Not set up';

	// The first one found ready becomes the person's choice there and then,
	// shown in the footer. From then on it is theirs: if it stops being ready,
	// the panel says so, and does not move on to another by itself.
	useEffect(() => {
		if (!prefs.backend && chosen) setPrefs({ backend: chosen.id });
	}, [prefs.backend, chosen?.id]);

	// --- an answer arriving -------------------------------------------------

	const patch = (target, change) =>
		setConversations((list) =>
			list.map((item) =>
				item.id !== target.conversationId ? item : { ...item, updatedAt: Date.now(), messages: item.messages.map((message) => (message.id === target.messageId ? change(message) : message)) }
			)
		);

	// Text comes a few letters at a time. It is gathered and drawn once a frame.
	const flush = (target) => {
		cancelAnimationFrame(frame.current);
		frame.current = 0;
		const text = waitingText.current;
		waitingText.current = '';
		if (text) patch(target, (message) => ({ ...message, text: message.text + text }));
	};

	const take = (event, target) => {
		if (event.type === 'text') {
			waitingText.current += event.text;
			if (!frame.current) frame.current = requestAnimationFrame(() => flush(target));
			return;
		}
		flush(target);
		if (event.type === 'found') {
			patch(target, (message) => ({ ...message, found: Array.isArray(event.hits) ? event.hits : [] }));
		} else if (event.type === 'tool') {
			patch(target, (message) => ({
				...message,
				tools: message.tools.some((tool) => tool.id === event.id)
					? message.tools.map((tool) => (tool.id === event.id ? { ...tool, status: event.status } : tool))
					: [...message.tools, { id: event.id, name: event.name, status: event.status }],
			}));
		} else if (event.type === 'proposal') {
			// Where in the answer the card came, so it is drawn there.
			patch(target, (message) => ({ ...message, cards: [...message.cards, { ...event.card, at: message.text.length }] }));
		} else if (event.type === 'done' || event.type === 'stopped' || event.type === 'error') {
			patch(target, (message) => ({
				...message,
				ending: event.type,
				error: event.type === 'error' ? { code: event.code, message: event.message } : null,
				tools: message.tools.map((tool) => (tool.status === 'started' ? { ...tool, status: 'failed' } : tool)),
			}));
			turn.current = null;
			setWorking(false);
			// The backend itself is what failed: look again at what it needs.
			if (event.type === 'error' && ['SIGNED_OUT', 'MISSING', 'OLD', 'NOT_RUNNING'].includes(event.code)) check();
		}
	};

	// An answer the window before this one left under way has nobody to hear it.
	useEffect(() => {
		api.chatStop(null).catch(() => {});
	}, []);

	useEffect(
		() =>
			api.on('chat:event', (event) => {
				const current = turn.current;
				if (!current) return;
				// Sent, and its name not back yet: keep what arrives until it is.
				if (current.id === null) return void current.early.push(event);
				if (event.turnId === current.id) take(event, current);
			}),
		[]
	);

	// --- sending ------------------------------------------------------------

	async function send(text) {
		const body = text.trim();
		// Not before the person has read where their text will go.
		if (!body || working || !chosen || mustTell) return;
		setNotice(null);
		setHeld(null);
		const question = { id: newId(), role: 'user', text: body };
		const answer = { id: newId(), role: 'assistant', text: '', backend: chosen.id, found: [], tools: [], cards: [], ending: null, error: null };
		const earlier = conversation?.messages ?? [];
		const conversationId = conversation?.id ?? newId();
		if (conversation) {
			setConversations((list) => list.map((item) => (item.id === conversationId ? { ...item, updatedAt: Date.now(), messages: [...item.messages, question, answer] } : item)));
		} else {
			setConversations((list) => [{ id: conversationId, title: titleOf(body), updatedAt: Date.now(), messages: [question, answer] }, ...list]);
			setCurrentId(conversationId);
		}
		setDraft('');
		setView('chat');
		setWorking(true);
		pinned.current = true;
		const current = { id: null, conversationId, messageId: answer.id, early: [], stopWanted: false };
		turn.current = current;
		try {
			const { turnId } = await api.chatSend({
				backend: chosen.id,
				model: model?.name,
				messages: [...earlier, question].map(forModel).filter(Boolean),
				context,
			});
			current.id = turnId;
			if (current.stopWanted) api.chatStop(turnId).catch(() => {});
			for (const event of current.early.splice(0)) {
				if (event.turnId === turnId && turn.current === current) take(event, current);
			}
		} catch (error) {
			// It never started: the message goes back into the box.
			turn.current = null;
			setWorking(false);
			setConversations((list) =>
				list
					.map((item) => (item.id === conversationId ? { ...item, messages: item.messages.filter((message) => message.id !== question.id && message.id !== answer.id) } : item))
					.filter((item) => item.messages.length)
			);
			if (!earlier.length) setCurrentId(null);
			setDraft(body);
			setNotice(error.message);
			if (error.code === 'NOT_READY') check();
		}
	}

	const stop = () => {
		const current = turn.current;
		if (!current) return;
		if (current.id === null) current.stopWanted = true;
		else api.chatStop(current.id).catch(() => {});
	};

	// --- cards --------------------------------------------------------------

	const setCard = (conversationId, messageId, card) =>
		patch({ conversationId, messageId }, (message) => ({ ...message, cards: message.cards.map((item) => (item.id === card.id ? { ...item, ...card } : item)) }));

	async function applyCard(conversationId, messageId, card) {
		// Unsaved edits in the same file would be overwritten or refused.
		if (card.fileId && isDirty(card.fileId)) {
			setHeld(card.id);
			return false;
		}
		setHeld(null);
		setCard(conversationId, messageId, { ...card, status: 'applying', message: null });
		try {
			const next = await api.chatApply(card.id);
			setCard(conversationId, messageId, next);
			if (next.status === 'applied') refresh();
			return next.status === 'applied';
		} catch (error) {
			setCard(conversationId, messageId, error.code === 'NOT_FOUND' ? { ...card, status: 'expired', message: null } : { ...card, status: 'pending', message: error.message, code: error.code ?? 'ERROR' });
			return false;
		}
	}

	async function applyAll(conversationId, message) {
		for (const card of message.cards) {
			if (card.status !== 'pending') continue;
			if (!(await applyCard(conversationId, message.id, card))) break;
		}
	}

	async function dismissCard(conversationId, messageId, card) {
		try {
			setCard(conversationId, messageId, await api.chatDismiss(card.id));
		} catch {
			setCard(conversationId, messageId, { ...card, status: 'expired', message: null });
		}
	}

	// --- the window around it -----------------------------------------------

	// Follow the answer down, unless the person has scrolled up to read.
	useEffect(() => {
		const el = log.current;
		if (!el || !pinned.current) return;
		el.scrollTop = el.scrollHeight;
		bottom.current = el.scrollTop;
	}, [conversations, working, view, currentId, open, sheet, prefs.width, prefs.wide]);

	useEffect(() => {
		if (open && view === 'chat') box.current?.focus();
	}, [open, view]);

	useEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = 'auto';
		el.style.height = `${Math.min(160, el.scrollHeight)}px`;
	}, [draft, open]);

	useEffect(() => {
		if (!menu) return undefined;
		// Opened, the menu takes the keyboard. Escape gives it back to its button.
		menuButton.current?.querySelector('[role="menuitem"]')?.focus();
		const away = (event) => {
			if (event.type === 'keydown') {
				if (event.key === 'Escape') closeMenu();
			} else if (!event.target.closest?.('.chat__menu-wrap')) setMenu(false);
		};
		window.addEventListener('pointerdown', away);
		window.addEventListener('keydown', away);
		return () => {
			window.removeEventListener('pointerdown', away);
			window.removeEventListener('keydown', away);
		};
	}, [menu]);

	const setWidth = (width) => setPrefs({ width: Math.max(CHAT_MIN, Math.min(CHAT_MAX, Math.round(width))) });
	const onResizeKey = (event) => {
		const next = { ArrowLeft: prefs.width + STEP, ArrowRight: prefs.width - STEP, Home: CHAT_MAX, End: CHAT_MIN }[event.key];
		if (next === undefined) return;
		event.preventDefault();
		setWidth(next);
	};

	// Closed from inside, the keyboard goes back to the button that opens it.
	const close = () => {
		onClose();
		requestAnimationFrame(() => document.querySelector('.topbar [aria-pressed]')?.focus());
	};
	// To a page: when the assistant covers the page, it makes way first.
	const leaveFor = (target) => {
		if (sheet || prefs.wide) onClose();
		navigate(target);
	};

	// A row of the closest matches says where a snippet was. It is opened where it is now.
	const openFound = (hit) => {
		const where = whereNow(files, hit);
		if (where) leaveFor(where);
		else setNotice(`${hit.fileName || 'That file'} is no longer among your snippets.`);
	};

	const closeMenu = () => {
		setMenu(false);
		menuButton.current?.querySelector('button')?.focus();
	};
	const onMenuKey = (event) => {
		const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]')];
		const at = items.indexOf(document.activeElement);
		const to = { ArrowDown: (at + 1) % items.length, ArrowUp: (at - 1 + items.length) % items.length, Home: 0, End: items.length - 1 }[event.key];
		if (to !== undefined) {
			event.preventDefault();
			items[to].focus();
		} else if (event.key === 'Tab') setMenu(false);
	};

	const startNew = () => {
		setCurrentId(null);
		setView('chat');
		setNotice(null);
		setDraft('');
		box.current?.focus();
	};

	const useStarter = (starter) => {
		if (starter.send) return send(starter.send);
		setDraft(starter.fill);
		box.current?.focus();
	};

	const seeing = context ? `${context.fileName}${context.trigger ? ` · ${context.trigger}` : ''}` : 'Nothing open';
	const title = view === 'history' ? 'History' : view === 'backends' ? 'Who answers' : 'Assistant';
	const needsSetup = status !== null && !chosen;

	// --- drawing ------------------------------------------------------------

	const messages = conversation?.messages ?? [];
	let body;
	if (view === 'history') {
		body = html`<div class="chat__history">
			${conversations.length === 0 && html`<p class="chat__lead">No conversations yet.</p>`}
			<ul class="chat__conversations">
				${conversations.map(
					(item) => html`<li>
						<button
							class="chat__conversation"
							aria-current=${item.id === currentId ? 'true' : undefined}
							disabled=${working}
							onClick=${() => {
								setCurrentId(item.id);
								setView('chat');
							}}
						>
							<span class="truncate">${item.title}</span>
							<span class="chat__when">${when(item.updatedAt)}</span>
						</button>
					</li>`
				)}
			</ul>
			${conversations.length > 0 &&
			html`<${Button}
				variant=${clearing ? 'destructive' : 'ghost'}
				size="sm"
				icon="trash"
				disabled=${working}
				onClick=${() => {
					if (!clearing) return setClearing(true);
					setConversations([]);
					setCurrentId(null);
					setClearing(false);
				}}
				onBlur=${() => setClearing(false)}
			>
				${clearing ? 'Delete every conversation' : 'Clear history'}
			<//>`}
		</div>`;
	} else if (view === 'backends' || needsSetup) {
		body = html`<${Backends}
			status=${status ?? []}
			chosen=${chosen}
			wanted=${chosen ? null : wanted}
			model=${model}
			checking=${checking}
			onChoose=${(id) => setPrefs({ backend: id })}
			onModel=${(name) => setPrefs({ model: name })}
			onCheck=${check}
		/>`;
	} else if (!messages.length) {
		body = html`<div class="chat__empty">
			<div class="chat__empty-icon"><${Icon} name="chat" /></div>
			<h3>What would you like to do?</h3>
			<p>Ask in your own words. A change is shown as a card, and nothing is written until you press Apply.</p>
			<div class="chat__starters">
				${STARTERS.map((starter) => {
					const available = !starter.needs || (starter.needs === 'file' ? Boolean(context) : Boolean(context?.trigger));
					return html`<button class="chat__starter" disabled=${!available || status === null} title=${available ? undefined : 'Open a file or a snippet first'} onClick=${() => useStarter(starter)}>
						${starter.label}
					</button>`;
				})}
			</div>
		</div>`;
	} else {
		body = messages.map((message) => {
			if (message.role === 'user') return html`<article class="msg msg--user" aria-label="You"><p>${message.text}</p></article>`;
			const waiting = message.cards.filter((card) => card.status === 'pending').length;
			const tools = toolLine(message.tools);
			return html`<article class="msg msg--assistant" aria-label="Assistant">
				${message.found.length > 0 && html`<${Found} hits=${message.found} onOpen=${openFound} />`}
				${tools && html`<p class="msg__tools">${tools}</p>`}
				${pieces(message).map(({ text, card }) =>
					card
						? html`<${ProposalCard}
								key=${card.id}
								card=${card}
								blocked=${held === card.id ? 'Save or discard your edits to this file first.' : null}
								onApply=${() => applyCard(conversation.id, message.id, card)}
								onDismiss=${() => dismissCard(conversation.id, message.id, card)}
								onShow=${() => leaveFor({ view: 'file', fileId: card.fileId })}
								onOpenSettings=${() => leaveFor({ view: 'settings' })}
								onOpenLink=${() => api.openTeamLink(card.link).catch((error) => setNotice(error.message))}
							/>`
						: html`<${Markdown} text=${text} />`
				)}
				${waiting > 1 && html`<div class="msg__all"><${Button} size="sm" variant="secondary" icon="check" onClick=${() => applyAll(conversation.id, message)}>Apply all ${waiting}<//></div>`}
				${message.ending === 'stopped' && html`<p class="msg__ending">Stopped.</p>`}
				${message.ending === 'error' && html`<${Alert} tone="danger" icon="alert">${message.error?.message ?? 'Something went wrong.'}<//>`}
				${message.ending === 'done' && !message.text && !message.cards.length && html`<p class="msg__ending">No answer came back.</p>`}
			</article>`;
		});
	}

	return html`<aside class="chat" aria-label="Assistant" hidden=${!open} data-dragging=${dragging ? '' : undefined}>
		${!sheet &&
		!prefs.wide &&
		html`<div
			class="chat__resize"
			role="separator"
			tabindex="0"
			aria-orientation="vertical"
			aria-label="Resize the assistant. Use the left and right arrow keys."
			aria-valuemin=${CHAT_MIN}
			aria-valuemax=${CHAT_MAX}
			aria-valuenow=${prefs.width}
			onPointerDown=${(event) => {
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = { x: event.clientX, width: prefs.width };
				setDragging(true);
			}}
			onPointerMove=${(event) => drag.current && setWidth(drag.current.width - (event.clientX - drag.current.x))}
			onPointerUp=${() => {
				drag.current = null;
				setDragging(false);
			}}
			onKeyDown=${onResizeKey}
		></div>`}
		<header class="chat__header">
			${view !== 'chat' && html`<${IconButton} label="Back to the conversation" icon="arrow-left" onClick=${() => setView('chat')} />`}
			<h2 class="chat__title">${title}</h2>
			<span class="spacer"></span>
			<${IconButton} label="New conversation" icon="plus" disabled=${working} onClick=${startNew} />
			<div class="chat__menu-wrap" ref=${menuButton}>
				<${IconButton} class="chat__menu-button" label="Assistant options" icon="more" aria-haspopup="menu" aria-expanded=${menu ? 'true' : 'false'} onClick=${() => setMenu(!menu)} />
				${menu &&
				html`<div class="chat__menu" role="menu" aria-label="Assistant options" onKeyDown=${onMenuKey}>
					<button
						role="menuitem"
						onClick=${() => {
							setMenu(false);
							setView('history');
						}}
					>
						<${Icon} name="history" />History
					</button>
					<button
						role="menuitem"
						onClick=${() => {
							setMenu(false);
							setView('backends');
						}}
					>
						<${Icon} name="team" />Who answers
					</button>
					${!sheet &&
					html`<button
						role="menuitem"
						onClick=${() => {
							setMenu(false);
							setPrefs({ wide: !prefs.wide });
						}}
					>
						<${Icon} name=${prefs.wide ? 'shrink' : 'expand'} />${prefs.wide ? 'Side panel' : 'Full width'}
					</button>`}
					<button
						role="menuitem"
						onClick=${() => {
							setMenu(false);
							leaveFor({ view: 'settings' });
						}}
					>
						<${Icon} name="settings" />Settings
					</button>
				</div>`}
			</div>
			<${IconButton} label="Close the assistant" icon="x" onClick=${close} />
		</header>

		<div
			class="chat__log"
			ref=${log}
			role="log"
			aria-live="polite"
			aria-busy=${working ? 'true' : 'false'}
			aria-label="Conversation"
			tabindex="0"
			onScroll=${(event) => {
				const el = event.currentTarget;
				// At the end, the panel follows. Away from the end it stops, unless it
				// is only where the panel itself last put it: more has arrived below
				// since, and that is not the person scrolling up to read.
				if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) pinned.current = true;
				else if (Math.abs(el.scrollTop - bottom.current) > 1) pinned.current = false;
			}}
		>
			${status === null && view === 'chat' && !messages.length ? html`<p class="chat__lead" role="status">Checking who can answer…</p>` : body}
			${working &&
			view === 'chat' &&
			html`<div class="chat__working" role="status">
				<span class="chat__spinner" aria-hidden="true"></span>
				<span>Working…</span>
				<span class="spacer"></span>
				<${Button} size="sm" variant="outline" icon="stop" onClick=${stop}>Stop<//>
			</div>`}
		</div>

		${notice &&
		html`<div class="chat__notice">
			<${Alert} tone="danger" icon="alert" actions=${html`<${Button} size="sm" variant="outline" onClick=${() => setNotice(null)}>Dismiss<//>`}>${notice}<//>
		</div>`}
		${mustTell &&
		view === 'chat' &&
		html`<div class="chat__notice">
			<${Alert} actions=${html`<${Button} size="sm" variant="outline" onClick=${() => setPrefs({ told: [...prefs.told, toldKey(chosen.id)] })}>OK<//>`}>
				${chosen.label} sends ${SENT}, to ${sendsTo}, under your own sign-in.
			<//>
		</div>`}

		<form
			class="chat__composer"
			onSubmit=${(event) => {
				event.preventDefault();
				send(draft);
			}}
		>
			<textarea
				ref=${box}
				class="chat__box"
				rows="2"
				aria-label="Message the assistant"
				placeholder=${chosen ? 'Ask about your snippets' : 'The assistant is not set up yet'}
				value=${draft}
				disabled=${!chosen}
				onInput=${(event) => setDraft(event.currentTarget.value)}
				onKeyDown=${(event) => {
					if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
					event.preventDefault();
					send(draft);
				}}
			></textarea>
			<div class="chat__send">
				<span class="chat__hint">Enter to send · Shift+Enter for a new line</span>
				<${Button} type="submit" size="sm" icon="send" disabled=${!chosen || working || mustTell || !draft.trim()}>Send<//>
			</div>
		</form>

		<footer class="chat__footer">
			<span class="chat__seeing truncate" title="The assistant is told what you have open">${seeing}</span>
			<button class="chat__provider" title="Who answers" onClick=${() => setView(view === 'backends' ? 'chat' : 'backends')}>${provider}</button>
		</footer>
	</aside>`;
}
