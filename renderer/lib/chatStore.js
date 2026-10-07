// The chat's history and preferences, kept in the window's own storage:
// up to 20 conversations of up to 100 messages. It is a convenience and is
// treated as one: storage that is missing, full or damaged never stops the
// chat. What is sound is kept, and the rest is let go.
//
// Proposals live in the app's memory, not here. A card that was still
// waiting when the app closed comes back as "expired", and an answer that
// was under way comes back as stopped.
//
// The closest matches shown with an answer are kept with it. A row says
// where a snippet was then: it is found again when it is pressed.

export const KEY = 'snippet-editor.chat.v1';
export const LIMITS = { conversations: 20, messages: 100, cardText: 4000 };
const MATCHES = 8;

const BACKENDS = ['claude', 'codex', 'ollama'];
const ENDINGS = ['done', 'stopped', 'error'];
const CARD_STATES = ['pending', 'applying', 'applied', 'stale', 'dismissed', 'expired'];
const SOURCES = ['local', 'package', 'team'];

// The notice that says where text is sent is agreed to once for each
// backend. What is sent grew when the app began to send the closest matches
// and what is open with every message, so an OK from before that is not an
// OK to this: the name it is kept under carries which notice it was.
const NOTICE = 2;
export const toldKey = (backend) => `${backend}@${NOTICE}`;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOr = (value, fallback) => (typeof value === 'string' ? value : fallback);
const list = (value) => (Array.isArray(value) ? value : []);
const strings = (value) => list(value).filter((item) => typeof item === 'string');

export const emptyState = () => ({ prefs: { open: false, width: 400, wide: false, backend: null, models: { claude: '', codex: '', ollama: '' }, told: [] }, conversations: [], current: null });

// What a conversation is called: its first message, on one short line.
export function titleOf(text) {
	const line = textOr(text, '').replace(/\s+/g, ' ').trim();
	if (!line) return 'New conversation';
	return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

const cut = (text) => (typeof text === 'string' && text.length > LIMITS.cardText ? `${text.slice(0, LIMITS.cardText)}\n[cut: ${text.length.toLocaleString('en-US')} characters in all]` : text);

function cardOf(raw, { reopened }) {
	if (!isObject(raw) || typeof raw.id !== 'string') return null;
	const status = CARD_STATES.includes(raw.status) ? raw.status : 'expired';
	return {
		id: raw.id,
		tool: textOr(raw.tool, ''),
		kind: textOr(raw.kind, ''),
		title: textOr(raw.title, ''),
		subject: textOr(raw.subject, ''),
		fileId: textOr(raw.fileId, null),
		fileName: textOr(raw.fileName, null),
		// Cut once, when it is saved. What is read back was cut then.
		before: typeof raw.before === 'string' ? (reopened ? raw.before : cut(raw.before)) : null,
		after: typeof raw.after === 'string' ? (reopened ? raw.after : cut(raw.after)) : null,
		lines: strings(raw.lines),
		warnings: strings(raw.warnings),
		// The app that held this card is gone, and the card with it.
		status: reopened && (status === 'pending' || status === 'applying') ? 'expired' : status,
		message: textOr(raw.message, null),
		code: textOr(raw.code, null),
		link: textOr(raw.link, null),
		// How far into the answer's text the card came.
		at: Number.isInteger(raw.at) && raw.at >= 0 ? raw.at : null,
	};
}

const upTo = (value, most) => textOr(value, '').slice(0, most);

function foundOf(raw) {
	if (!isObject(raw) || typeof raw.fileId !== 'string' || !raw.fileId || !Number.isInteger(raw.index) || raw.index < 0) return null;
	return {
		fileId: raw.fileId.slice(0, 300),
		fileName: upTo(raw.fileName, 80),
		source: SOURCES.includes(raw.source) ? raw.source : 'local',
		...(typeof raw.package === 'string' && raw.package ? { package: raw.package.slice(0, 80) } : {}),
		index: raw.index,
		triggers: strings(raw.triggers)
			.slice(0, 5)
			.map((trigger) => trigger.slice(0, 80)),
		label: upTo(raw.label, 80),
		preview: upTo(raw.preview, 120),
	};
}

function messageOf(raw, options) {
	if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.text !== 'string') return null;
	if (raw.role === 'user') return { id: raw.id, role: 'user', text: raw.text };
	if (raw.role !== 'assistant') return null;
	const unfinished = !ENDINGS.includes(raw.ending);
	return {
		id: raw.id,
		role: 'assistant',
		text: raw.text,
		backend: BACKENDS.includes(raw.backend) ? raw.backend : null,
		found: list(raw.found).map(foundOf).filter(Boolean).slice(0, MATCHES),
		tools: list(raw.tools)
			.filter((tool) => isObject(tool) && typeof tool.id === 'string' && typeof tool.name === 'string')
			.map((tool) => ({ id: tool.id, name: tool.name, status: options.reopened && tool.status !== 'done' ? 'failed' : textOr(tool.status, 'failed') })),
		cards: list(raw.cards)
			.map((card) => cardOf(card, options))
			.filter(Boolean),
		ending: unfinished ? (options.reopened ? 'stopped' : null) : raw.ending,
		error: isObject(raw.error) && typeof raw.error.message === 'string' ? { code: textOr(raw.error.code, 'ERROR'), message: raw.error.message } : null,
	};
}

function conversationOf(raw, options) {
	if (!isObject(raw) || typeof raw.id !== 'string' || !Array.isArray(raw.messages)) return null;
	const messages = raw.messages
		.map((message) => messageOf(message, options))
		.filter(Boolean)
		.slice(-LIMITS.messages);
	if (!messages.length) return null;
	return {
		id: raw.id,
		title: typeof raw.title === 'string' && raw.title ? raw.title : titleOf(messages.find((message) => message.role === 'user')?.text),
		updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
		messages,
	};
}

// Anything at all, made into a state the panel can rely on.
function sound(raw, options) {
	const state = emptyState();
	if (!isObject(raw)) return state;
	const prefs = isObject(raw.prefs) ? raw.prefs : {};
	const models = isObject(prefs.models) ? prefs.models : {};
	state.prefs = {
		open: prefs.open === true,
		width: Number.isFinite(prefs.width) ? Math.min(1200, Math.max(320, Math.round(prefs.width))) : 400,
		wide: prefs.wide === true,
		backend: BACKENDS.includes(prefs.backend) ? prefs.backend : null,
		// The model chosen for each backend. An empty one is the backend's own
		// choice. Before there was a choice for each, the one model was Ollama's.
		models: {
			claude: upTo(models.claude, 200),
			codex: upTo(models.codex, 200),
			ollama: upTo(isObject(prefs.models) ? models.ollama : prefs.model, 200),
		},
		told: strings(prefs.told).filter((key) => BACKENDS.some((id) => key === toldKey(id))),
	};
	state.conversations = list(raw.conversations)
		.map((conversation) => conversationOf(conversation, options))
		.filter(Boolean)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, LIMITS.conversations);
	state.current = state.conversations.some((conversation) => conversation.id === raw.current) ? raw.current : null;
	return state;
}

export function createChatStore(storage) {
	return {
		load() {
			try {
				return sound(JSON.parse(storage.getItem(KEY)), { reopened: true });
			} catch {
				return emptyState();
			}
		},

		// True when it was saved. When there is not room, the oldest
		// conversations give way, one at a time.
		save(state) {
			let kept;
			try {
				kept = sound(state, { reopened: false });
			} catch {
				return false;
			}
			for (;;) {
				try {
					storage.setItem(KEY, JSON.stringify(kept));
					return true;
				} catch {
					if (!kept.conversations.length) return false;
					kept = { ...kept, conversations: kept.conversations.slice(0, -1) };
					if (!kept.conversations.some((conversation) => conversation.id === kept.current)) kept.current = null;
				}
			}
		},
	};
}
