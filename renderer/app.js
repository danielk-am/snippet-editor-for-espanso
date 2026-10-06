import { html, render, useCallback, useEffect, useRef, useState } from './vendor/preact-htm.js';
import { matchTriggers } from '../shared/snippetModel.js';
import { api, allFiles, findFile, platform, sourceLabel } from './lib/api.js';
import { chatInitial } from './lib/chatSession.js';
import { Icon } from './lib/icons.js';
import { toText } from '../shared/text.js';
import { Button, ConfirmDialog, Empty, ErrorBoundary, IconButton, ToastProvider } from './lib/ui.js';
import { ChatPanel } from './components/ChatPanel.js';
import { CommandPalette } from './components/CommandPalette.js';
import { FileDetailsDialog, NewFileDialog } from './components/dialogs.js';
import { FileView } from './components/FileView.js';
import { Overview } from './components/Overview.js';
import { SearchResults } from './components/SearchResults.js';
import { SettingsPage } from './components/SettingsPage.js';
import { Sidebar } from './components/Sidebar.js';
import { SnippetEditor } from './components/SnippetEditor.js';
import { TeamPage } from './components/TeamPage.js';

const NARROW = '(max-width: 900px)';
// Below this the assistant covers the page instead of sitting beside it.
const CHAT_SHEET = '(max-width: 1119px)';
const MOD = platform === 'darwin' ? '⌘' : 'Ctrl';

// Preferences that belong to this window rather than to the snippets live in
// localStorage, which can be unavailable; the app must still open without it.
const stored = {
	get(key, fallback) {
		try {
			return localStorage.getItem(`snippet-editor:${key}`) ?? fallback;
		} catch {
			return fallback;
		}
	},
	set(key, value) {
		try {
			localStorage.setItem(`snippet-editor:${key}`, value);
		} catch {
			// Nothing to do: the preference lasts for this session only.
		}
	},
};

function useTheme() {
	const [theme, setTheme] = useState(() => {
		const saved = stored.get('theme', 'light');
		return ['system', 'light', 'dark'].includes(saved) ? saved : 'light';
	});
	useEffect(() => {
		stored.set('theme', theme);
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const apply = () => {
			document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
		};
		apply();
		media.addEventListener('change', apply);
		return () => media.removeEventListener('change', apply);
	}, [theme]);
	return [theme, setTheme];
}

function useMediaQuery(query) {
	const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const media = window.matchMedia(query);
		const update = () => setMatches(media.matches);
		media.addEventListener('change', update);
		return () => media.removeEventListener('change', update);
	}, [query]);
	return matches;
}

const clampWidth = (width) => Math.max(220, Math.min(420, Math.round(width)));

function App() {
	const [state, setState] = useState(null);
	const [loadError, setLoadError] = useState('');
	const [route, setRoute] = useState({ view: 'overview' });
	const [pendingRoute, setPendingRoute] = useState(null);
	const [palette, setPalette] = useState(false);
	const [newFile, setNewFile] = useState(null);
	const [detailsFor, setDetailsFor] = useState(null);
	const [theme, setTheme] = useTheme();
	const narrow = useMediaQuery(NARROW);
	const [collapsed, setCollapsed] = useState(() => stored.get('sidebar', 'open') === 'collapsed');
	const [drawer, setDrawer] = useState(false);
	const [width, setWidthState] = useState(() => clampWidth(Number(stored.get('sidebar-width', 272)) || 272));
	const dirty = useRef(false);
	const content = useRef(null);
	const [chatPrefs, setChatPrefsState] = useState(chatInitial.prefs);
	const setChatPrefs = useCallback((changes) => setChatPrefsState((prefs) => ({ ...prefs, ...changes })), []);
	const chatSheet = useMediaQuery(CHAT_SHEET);
	const toggleChat = () => setChatPrefsState((prefs) => ({ ...prefs, open: !prefs.open }));

	const refresh = useCallback(async () => {
		try {
			setState(await api.load());
			setLoadError('');
		} catch (failure) {
			setLoadError(failure.message);
		}
	}, []);

	useEffect(() => {
		refresh();
		return api.on('data:changed', refresh);
	}, []);

	const setDirty = useCallback((value) => {
		dirty.current = value;
	}, []);

	const navigate = useCallback((next, { force } = {}) => {
		if (dirty.current && !force) return setPendingRoute(next);
		dirty.current = false;
		setDrawer(false);
		setRoute(next);
	}, []);

	useEffect(() => {
		if (content.current) content.current.scrollTop = 0;
	}, [route]);

	const setWidth = (next) => {
		const value = clampWidth(next);
		setWidthState(value);
		stored.set('sidebar-width', String(value));
	};

	const toggleSidebar = () => {
		if (narrow) return setDrawer(!drawer);
		stored.set('sidebar', collapsed ? 'open' : 'collapsed');
		setCollapsed(!collapsed);
	};

	const routeFile = state && route.fileId ? findFile(state, route.fileId) : null;

	// A new snippet goes into the file you are looking at when that file can
	// take one, and otherwise into your first ordinary file.
	const newSnippet = (file) => {
		const usable = (candidate) => candidate && !candidate.readOnly && candidate.matches !== null;
		const target = [file, routeFile, ...state.files.filter((candidate) => !candidate.importOnly), ...state.files].find(usable);
		if (!target) return setNewFile({ thenSnippet: true });
		navigate({ view: 'snippet', fileId: target.id, index: 'new' });
	};

	const actions = [
		{ icon: 'plus', label: 'New snippet', hint: `${MOD} N`, run: () => newSnippet() },
		{ icon: 'file', label: 'New file', hint: `${MOD} ⇧ N`, run: () => setNewFile({}) },
		{ icon: 'overview', label: 'Go to Overview', run: () => navigate({ view: 'overview' }) },
		{ icon: 'list', label: 'Go to All snippets', run: () => navigate({ view: 'all' }) },
		{ icon: 'team', label: 'Go to Team packages', run: () => navigate({ view: 'team' }) },
		{ icon: 'settings', label: 'Go to Settings', hint: `${MOD} ,`, run: () => navigate({ view: 'settings' }) },
		{ icon: 'chat', label: chatPrefs.open ? 'Hide the assistant' : 'Show the assistant', hint: `${MOD} J`, run: toggleChat },
		{ icon: 'sun', label: 'Use the light theme', run: () => setTheme('light') },
		{ icon: 'moon', label: 'Use the dark theme', run: () => setTheme('dark') },
		{ icon: 'monitor', label: 'Match the system theme', run: () => setTheme('system') },
	];

	// Menu items and shortcuts call the newest handlers through this ref.
	const commands = useRef({});
	commands.current = {
		'new-snippet': () => state && newSnippet(),
		'new-file': () => setNewFile({}),
		// One modal at a time: the palette does not open over a dialog.
		search: () => (palette || !document.querySelector('.overlay')) && setPalette(!palette),
		settings: () => navigate({ view: 'settings' }),
		assistant: toggleChat,
	};
	useEffect(() => {
		const off = api.on('menu:command', (name) => commands.current[name]?.());
		const onKey = (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				commands.current.search();
			}
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
				event.preventDefault();
				commands.current.assistant();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => {
			off();
			window.removeEventListener('keydown', onKey);
		};
	}, []);

	if (!state) {
		return html`<div class="boot" role="status">
			${loadError
				? html`<${Empty}
						icon="alert"
						title="The snippets could not be read"
						actions=${html`
							<${Button} icon="refresh" onClick=${refresh}>Try again<//>
							<${Button} variant="outline" icon="folder" onClick=${() => api.chooseMatchDir().then(refresh, refresh)}>Choose another folder<//>
						`}
					>
						${loadError}
					<//>`
				: 'Loading snippets…'}
		</div>`;
	}

	const snippetCount = allFiles(state).reduce((sum, file) => sum + (file.matchCount ?? 0), 0);
	const chatState = !chatPrefs.open ? 'closed' : chatPrefs.wide && !chatSheet ? 'wide' : 'side';
	const missingFile = (route.view === 'file' || route.view === 'snippet') && !routeFile;
	const sidebarState = narrow ? (drawer ? 'open' : 'collapsed') : collapsed ? 'collapsed' : 'open';

	const crumb = (label, target) =>
		target ? html`<button class="crumbs__link" onClick=${() => navigate(target)}>${label}</button>` : html`<span class="crumbs__current truncate">${label}</span>`;
	const sep = html`<${Icon} name="chevron-right" />`;
	let crumbs;
	if (route.view === 'overview') crumbs = crumb('Overview');
	else if (route.view === 'all') crumbs = crumb('All snippets');
	else if (route.view === 'settings') crumbs = crumb('Settings');
	else if (route.view === 'team') crumbs = crumb('Team packages');
	else if (missingFile) crumbs = crumb('Not found');
	else {
		const group = routeFile.source === 'local' ? 'Local' : `${sourceLabel(routeFile)} / ${routeFile.package}`;
		const match = route.index === 'new' ? null : routeFile.matches?.[route.index];
		crumbs =
			route.view === 'file'
				? html`<span>${group}</span>${sep}${crumb(routeFile.name)}`
				: html`<span>${group}</span>${sep}${crumb(routeFile.name, { view: 'file', fileId: routeFile.id })}${sep}${crumb(
						route.index === 'new' ? 'New snippet' : (match && (toText(match.label) || matchTriggers(match)[0])) || 'Snippet'
					)}`;
	}

	let page;
	if (missingFile) {
		page = html`<div class="page">
			<${Empty} icon="alert" title="That file is no longer in the match folder" actions=${html`<${Button} onClick=${() => navigate({ view: 'overview' }, { force: true })}>Back to Overview<//>`}>
				It was moved, renamed or deleted outside this app.
			<//>
		</div>`;
	} else if (route.view === 'overview') {
		page = html`<${Overview} state=${state} navigate=${navigate} snippetCount=${snippetCount} onNewFile=${() => setNewFile({})} onNewSnippet=${newSnippet} />`;
	} else if (route.view === 'all') {
		page = html`<${SearchResults} key=${route.query ?? ''} state=${state} query=${route.query} navigate=${navigate} onNewSnippet=${newSnippet} />`;
	} else if (route.view === 'settings') {
		page = html`<${SettingsPage} state=${state} theme=${theme} setTheme=${setTheme} refresh=${refresh} navigate=${navigate} />`;
	} else if (route.view === 'team') {
		page = html`<${TeamPage} navigate=${navigate} refresh=${refresh} />`;
	} else if (route.view === 'file') {
		page = html`<${FileView}
			key=${routeFile.id}
			state=${state}
			file=${routeFile}
			tab=${route.tab}
			navigate=${navigate}
			refresh=${refresh}
			setDirty=${setDirty}
			onEditDetails=${setDetailsFor}
			onNewSnippet=${newSnippet}
		/>`;
	} else {
		page = html`<${SnippetEditor}
			key=${`${routeFile.id}#${route.index}#${route.insertAt ?? ''}`}
			state=${state}
			file=${routeFile}
			index=${route.index}
			seed=${route.seed}
			insertAt=${route.insertAt}
			navigate=${navigate}
			refresh=${refresh}
			setDirty=${setDirty}
		/>`;
	}

	// What the assistant is told is open: the file, and the snippet when one is.
	const openMatch = routeFile && route.view === 'snippet' && Number.isInteger(route.index) ? routeFile.matches?.[route.index] : null;
	const chatContext = routeFile ? { fileId: routeFile.id, fileName: routeFile.name, ...(openMatch ? { index: route.index, trigger: matchTriggers(openMatch)[0] ?? '' } : {}) } : null;

	return html`<div class="app" data-sidebar=${sidebarState} data-chat=${chatState} style=${{ '--sidebar-width': `${width}px`, '--chat-width': `${chatPrefs.width}px` }}>
		<${Sidebar}
			state=${state}
			route=${route}
			navigate=${navigate}
			theme=${theme}
			setTheme=${setTheme}
			width=${width}
			setWidth=${setWidth}
			snippetCount=${snippetCount}
			onNewFile=${() => setNewFile({})}
		/>
		${narrow && drawer && html`<button class="sidebar-scrim" aria-label="Close the sidebar" onClick=${() => setDrawer(false)}></button>`}
		<div class="main">
			<header class="topbar">
				<${IconButton} label=${sidebarState === 'open' ? 'Hide the sidebar' : 'Show the sidebar'} icon="sidebar" onClick=${toggleSidebar} />
				<nav class="crumbs" aria-label="Breadcrumb">${crumbs}</nav>
				<span class="spacer"></span>
				<button class="search-trigger" aria-label="Search snippets, files and actions" onClick=${() => setPalette(true)}>
					<${Icon} name="search" />
					<span>Search</span>
					<kbd class="kbd">${MOD} K</kbd>
				</button>
				<${Button} icon="plus" onClick=${() => newSnippet()}>New snippet<//>
				<${IconButton} label=${chatPrefs.open ? 'Hide the assistant' : 'Show the assistant'} icon="chat" aria-pressed=${chatPrefs.open ? 'true' : 'false'} onClick=${toggleChat} />
			</header>
			<main class="content" ref=${content}>
				<${ErrorBoundary}
					key=${JSON.stringify([route.view, route.fileId, route.index, route.tab])}
					fallback=${(error) =>
						html`<div class="page">
							<${Empty} icon="alert" title="This screen could not be shown" actions=${html`<${Button} onClick=${() => navigate({ view: 'overview' }, { force: true })}>Back to Overview<//>`}>
								Something in this file has a shape the app did not expect (${error.message}). The file itself has not been changed.
							<//>
						</div>`}
				>
					${page}
				<//>
			</main>
		</div>

		<${ChatPanel}
			open=${chatPrefs.open}
			sheet=${chatSheet}
			prefs=${chatPrefs}
			setPrefs=${setChatPrefs}
			context=${chatContext}
			isDirty=${(fileId) => dirty.current && route.fileId === fileId}
			refresh=${refresh}
			navigate=${navigate}
			onClose=${() => setChatPrefs({ open: false })}
		/>

		${palette && html`<${CommandPalette} state=${state} actions=${actions} navigate=${navigate} onClose=${() => setPalette(false)} />`}
		${newFile &&
		html`<${NewFileDialog}
			onClose=${() => setNewFile(null)}
			onCreated=${async (file) => {
				const then = newFile.thenSnippet;
				setNewFile(null);
				await refresh();
				navigate(then ? { view: 'snippet', fileId: file.id, index: 'new' } : { view: 'file', fileId: file.id });
			}}
		/>`}
		${detailsFor &&
		html`<${FileDetailsDialog}
			file=${detailsFor}
			onClose=${() => setDetailsFor(null)}
			onSaved=${async () => {
				setDetailsFor(null);
				await refresh();
			}}
		/>`}
		${pendingRoute &&
		html`<${ConfirmDialog}
			title="Discard unsaved changes?"
			description="Your edits to this snippet or file have not been saved."
			confirmLabel="Discard changes"
			cancelLabel="Keep editing"
			destructive
			onClose=${() => setPendingRoute(null)}
			onConfirm=${() => {
				const next = pendingRoute;
				setPendingRoute(null);
				navigate(next, { force: true });
			}}
		/>`}
	</div>`;
}

document.documentElement.dataset.platform = platform;
const root = document.getElementById('root');
root.textContent = '';
const crashed = (error) =>
	html`<div class="boot">
		<${Empty} icon="alert" title="Snippet Editor ran into a problem" actions=${html`<${Button} icon="refresh" onClick=${() => location.reload()}>Reload<//>`}>
			${error.message}. Your files have not been changed.
		<//>
	</div>`;
render(html`<${ErrorBoundary} fallback=${crashed}><${ToastProvider}><${App} /><//><//>`, root);
