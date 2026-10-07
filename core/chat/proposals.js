import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { brokenFile, createTools, explain, fileRuns, outOfRange, snippetProblem, snippetRuns, triggersOf } from '../../mcp/tools.mjs';
import { repositoryLabel } from '../../shared/repositoryLabel.js';
import { ANY_BREAK, oddBreak, oddBreakMessage } from '../../shared/text.js';
import { whichRepository } from '../apiRouter.js';
import { isSafeFileName } from '../store.js';
import { repositoryKey } from '../teamAddress.js';
import { PACKAGE_NAME } from '../teamRepo.js';
import { createInProcessApi } from './inProcess.js';

// "It proposes, you apply."
//
// In chat the assistant changes nothing. A tool call that would change
// something arrives here, is checked against the app as it is now, and
// becomes a card: what would change, shown as it is and as it would be. The
// person presses Apply, and only then is anything written, through the same
// routes the window uses.
//
// Between the card and Apply the file can change, by hand or because an
// earlier card was applied. So each card keeps what it was made for, and
// Apply first asks whether the card still means the same thing:
//   - a new snippet always does;
//   - a change or a deletion does while the snippet it was made for is still
//     in the file, unchanged. If it moved, it is found by its content;
//   - a new text for a file, and a file sent to the team, do while the file's
//     text is what the card was made from;
//   - a card for a team repository, to install from it or to send to it, does
//     while that repository is connected. Each card names its own, so one
//     connected since changes nothing, and nothing goes to another in its place.
// When it does not, nothing is written and the card says to ask again.

const COMMAND = 'Runs a command on your computer each time it is used.';
const SWITCH_OFF = 'Changes by AI tools are switched off. Switch on "Let AI tools change snippets" in Settings, then press Apply again.';
const STALE = 'This changed after the proposal was made. Ask again.';
const ENDED = 'This chat has ended. The person can send their message again.';
// The most text a card is made for: what the app can check for commands, and
// what a person can be expected to read on a card.
const MAX_CARD_TEXT = 256 * 1024;

const refused = (message) => Object.assign(new Error(message), { code: 'REFUSED' });
const stale = () => Object.assign(new Error(STALE), { code: 'STALE' });
const oneLine = (value, most) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= most && !/[\r\n]/.test(value);
const pathOf = (fileId) => `/files/${encodeURIComponent(fileId)}`;
const count = (number, word) => `${number} ${word}${number === 1 ? '' : 's'}`;

export function createProposals({ router, aiWrite, onCard = () => {}, log = console.error, limit = 200 }) {
	// The app's routes, for making a card and for Apply.
	const api = createInProcessApi({ router, aiWrite });
	// The same routes as the assistant's own tools reach them: to read, only.
	const reach = createInProcessApi({ router, aiWrite, readOnly: true });
	const kept = new Map();

	// --- reading the app, with a refusal the model can act on ----------------

	async function ask(method, path, options, context) {
		const reply = await api.request(method, path, options);
		if (reply.status >= 400) throw refused(explain(reply, context));
		return reply.body;
	}

	// One of the person's own files, as it is now.
	async function ownFile(fileId) {
		const file = await ask('GET', pathOf(fileId), {}, { fileId });
		if (file.readOnly) throw refused(explain({ body: { error: { code: 'READ_ONLY' } } }, { file: file.name, fileId }));
		return file;
	}

	const current = (file, version) => {
		if (version !== file.version) throw refused(explain({ body: { error: { code: 'CONFLICT' } } }, { file: file.name, fileId: file.id }));
	};

	const withSnippets = (file) => {
		if (file.matches === null) throw refused(brokenFile(file));
	};

	const snippetAt = (file, index) => {
		if (index >= file.matches.length) throw refused(outOfRange(file));
		return file.matches[index];
	};

	const yamlOf = async (match) => (await ask('POST', '/yaml/preview', { body: { match } })).yaml;

	function checked(snippet) {
		// A trigger that is a number or a switch is shown as text on the card,
		// and the app would refuse to write it.
		const triggers = [snippet.trigger, snippet.regex, ...(Array.isArray(snippet.triggers) ? snippet.triggers : [snippet.triggers])].filter((value) => value !== undefined);
		if (triggers.some((value) => typeof value !== 'string')) throw refused('Write each trigger as text, in quotes. Example: {"trigger": "123", "replace": "..."}.');
		const problem = snippetProblem(snippet);
		if (problem) throw refused(problem);
	}

	// --- which team repository a call means -----------------------------------
	//
	// The rule the app's routes follow, asked before a card is made, so that a
	// call the app would refuse is refused now, in words the model can act on.

	const teamRefusal = (code, message) => refused(explain({ body: { error: { code, message } } }, { tool: 'team' }));

	async function connectedRepositories() {
		const { repositories } = await ask('GET', '/team');
		if (!repositories.length) throw teamRefusal('NOT_CONNECTED');
		return repositories;
	}

	function repositoryWithId(repositories, id) {
		const found = repositories.find((repository) => repository.id === id);
		if (!found) throw teamRefusal('NOT_FOUND', 'That repository is not connected.');
		return found;
	}

	const which = (repositories, what) => teamRefusal('AMBIGUOUS', whichRepository(repositories.map((repository) => ({ name: repositoryLabel(repository.repository), id: repository.id })), what));

	// The repository a card was made for, as it is now, or nothing when it has
	// been disconnected since. A card remembers its repository's address, and
	// a repository is its host, owner and name. Disconnected and connected
	// again under the other form of its address, it is still the card's own.
	// A folder, which only a test connects, has no such name: it is itself.
	const sameRepository = (one, other) => one === other || (repositoryKey(one) !== '' && repositoryKey(one) === repositoryKey(other));
	const stillConnected = async (address) => (await route('GET', '/team')).repositories.find((repository) => sameRepository(repository.repository, address));

	// --- the app's own words, for the person ---------------------------------

	// A failure the app described itself, as opposed to a fault in this file.
	const failed = (code, message) => Object.assign(new Error(message), { code, described: true });

	async function route(method, path, options) {
		const reply = await api.request(method, path, options);
		if (reply.status >= 400) throw failed(reply.body?.error?.code ?? 'ERROR', reply.body?.error?.message ?? 'Something went wrong inside the app.');
		return reply.body;
	}

	// Where the snippet a card was made for is now, or nowhere.
	function locate(matches, target, index) {
		if (!Array.isArray(matches)) throw stale();
		if (index < matches.length && isDeepStrictEqual(matches[index], target)) return index;
		const found = matches.flatMap((match, position) => (isDeepStrictEqual(match, target) ? [position] : []));
		if (found.length !== 1) throw stale();
		return found[0];
	}

	// --- one entry per tool: the card it makes, and what Apply does ----------

	const kinds = {
		snippets_add_snippet: {
			async build({ file_id: fileId, snippet, version }) {
				checked(snippet);
				const file = await ownFile(fileId);
				withSnippets(file);
				current(file, version);
				return {
					card: { kind: 'add', title: `Add a snippet to ${file.name}`, subject: triggersOf(snippet).join(', '), fileId: file.id, fileName: file.name, after: await yamlOf(snippet), warnings: snippetRuns(snippet) ? [COMMAND] : [] },
				};
			},
			async apply({ args }) {
				const file = await route('GET', pathOf(args.file_id));
				const index = args.index !== undefined && Array.isArray(file.matches) && args.index <= file.matches.length ? args.index : undefined;
				await route('POST', `${pathOf(args.file_id)}/snippets`, { body: { match: args.snippet, index, version: file.version } });
			},
		},

		snippets_update_snippet: {
			async build({ file_id: fileId, index, snippet, version }) {
				checked(snippet);
				const file = await ownFile(fileId);
				withSnippets(file);
				current(file, version);
				const target = snippetAt(file, index);
				return {
					card: {
						kind: 'update',
						title: `Change a snippet in ${file.name}`,
						subject: triggersOf(snippet).join(', '),
						fileId: file.id,
						fileName: file.name,
						before: await yamlOf(target),
						after: await yamlOf(snippet),
						warnings: snippetRuns(snippet) ? [COMMAND] : [],
					},
					made: { target },
				};
			},
			async apply({ args, made }) {
				const file = await route('GET', pathOf(args.file_id));
				const index = locate(file.matches, made.target, args.index);
				await route('PUT', `${pathOf(args.file_id)}/snippets/${index}`, { body: { match: args.snippet, version: file.version } });
			},
		},

		snippets_delete_snippet: {
			async build({ file_id: fileId, index, version }) {
				const file = await ownFile(fileId);
				withSnippets(file);
				current(file, version);
				const target = snippetAt(file, index);
				return {
					card: { kind: 'delete', title: `Delete a snippet from ${file.name}`, subject: triggersOf(target).join(', '), fileId: file.id, fileName: file.name, before: await yamlOf(target) },
					made: { target },
				};
			},
			async apply({ args, made }) {
				const file = await route('GET', pathOf(args.file_id));
				const index = locate(file.matches, made.target, args.index);
				await route('DELETE', `${pathOf(args.file_id)}/snippets/${index}`, { query: { version: file.version } });
			},
		},

		snippets_create_file: {
			async build({ name, description, prefix }) {
				if (!isSafeFileName(name)) throw refused('Use a file name ending in .yml, without slashes or a leading dot.');
				// Either would be written into the file's first lines.
				for (const [what, value] of [['description', description], ['prefix', prefix]]) {
					const odd = oddBreak(value);
					if (odd) throw refused(`The ${what}: ${oddBreakMessage(odd)}`);
				}
				if (typeof prefix === 'string' && ANY_BREAK.test(prefix)) throw refused('A prefix is one line: it cannot hold a line break.');
				const state = await ask('GET', '/state');
				const taken = state.files.find((file) => file.name.toLowerCase() === name.toLowerCase());
				if (taken) throw refused(explain({ body: { error: { code: 'EXISTS', message: `A file named ${taken.name} already exists.` } } }));
				const lines = [description ? `Description: ${description}` : '', prefix ? `Prefix: ${prefix}` : ''].filter(Boolean);
				return { card: { kind: 'create-file', title: `Create the file ${name}`, subject: name, fileName: name, lines } };
			},
			async apply({ args }) {
				await route('POST', '/files', { body: { name: args.name, description: args.description, prefix: args.prefix } });
			},
		},

		snippets_replace_file_yaml: {
			async build({ file_id: fileId, yaml, version }) {
				const file = await ownFile(fileId);
				current(file, version);
				// Espanso would read this text differently from the card, and from the check for commands below.
				const odd = oddBreak(yaml);
				if (odd) throw refused(oddBreakMessage(odd));
				if (yaml.length > MAX_CARD_TEXT) {
					throw refused('That text is too long to show on a card (over 256 KB). Ask the person to make this change in the raw editor, or change the snippets one at a time.');
				}
				const warnings = [];
				const parsed = await api.request('POST', '/yaml/parse', { body: { text: yaml } });
				if (parsed.status === 413 || parsed.body?.error?.code === 'UNREPRESENTABLE') warnings.push('This text could not be checked for snippets that run commands. Read it before you apply.');
				else if (parsed.status >= 400) throw refused(explain(parsed, { fileId }));
				else if (fileRuns(parsed.body.value)) warnings.push('This text holds a snippet that runs a command on your computer each time it is used.');
				return {
					card: { kind: 'replace-file', title: `Replace the text of ${file.name}`, subject: file.name, fileId: file.id, fileName: file.name, before: file.text, after: yaml, warnings },
					made: { text: file.text },
				};
			},
			async apply({ args, made }) {
				const file = await route('GET', pathOf(args.file_id));
				if (file.text !== made.text) throw stale();
				await route('PUT', `${pathOf(args.file_id)}/raw`, { body: { text: args.yaml, version: file.version } });
			},
		},

		snippets_install_team_package: {
			async build({ name, repository }) {
				const repositories = await connectedRepositories();
				let source;
				if (repository !== undefined) source = repositoryWithId(repositories, repository);
				else {
					const offering = repositories.filter((item) => item.packages.some((pkg) => pkg.name === name));
					// Several offer it. If one of them holds the name already, the card
					// is for that one, as the app's route would have it: an update.
					const holding = offering.filter((item) => item.packages.some((pkg) => pkg.name === name && pkg.installed));
					if (offering.length > 1 && holding.length !== 1) throw which(offering, `offer ${name}`);
					// The only one connected answers for a name it does not have.
					source = offering.length > 1 ? holding[0] : (offering[0] ?? (repositories.length === 1 ? repositories[0] : null));
					if (!source) throw teamRefusal('NOT_FOUND', `No connected repository has a package named ${name}.`);
				}
				const pkg = source.packages.find((item) => item.name === name);
				if (!pkg) throw teamRefusal('NOT_FOUND', `${repositoryLabel(source.repository)} has no package named ${name}.`);
				// The name is held by another repository's package. A card for it could only fail.
				if (pkg.installedFrom) throw teamRefusal('EXISTS', `A package named ${name} is already installed from ${repositoryLabel(pkg.installedFrom)}. Remove it first, then install this one.`);
				if (pkg.matchCount === null) throw refused('This package was not read, so it cannot be installed from here.');
				return {
					card: {
						kind: 'install',
						title: `${pkg.installed ? 'Update' : 'Install'} the team package ${name}`,
						subject: name,
						lines: [`Repository: ${repositoryLabel(source.repository)}`, pkg.title, pkg.description, count(pkg.matchCount, 'snippet')].filter(Boolean),
						warnings: pkg.runsCommands ? ['This package runs commands on your computer when its snippets are used.'] : [],
					},
					made: { repository: source.repository, runsCommands: pkg.runsCommands === true },
				};
			},
			async apply({ args, made }) {
				// The person agreed to what the card showed, and to nothing more:
				// this package, from this repository, running commands or not.
				const source = await stillConnected(made.repository);
				const pkg = source?.packages.find((item) => item.name === args.name);
				if (!pkg || (pkg.runsCommands === true) !== made.runsCommands) throw stale();
				// If the name was installed from another repository meanwhile, the
				// app refuses, and its own words go on the card.
				await route('PUT', `/team/packages/${encodeURIComponent(args.name)}/installed`, { body: { repository: source.id, acceptCommands: made.runsCommands } });
			},
		},

		snippets_propose_to_team: {
			async build({ file_id: fileId, repository, package: name, summary, title, description }) {
				const repositories = await connectedRepositories();
				// With several connected, which one has to be said.
				if (repository === undefined && repositories.length > 1) throw which(repositories, 'are connected');
				const team = repository === undefined ? repositories[0] : repositoryWithId(repositories, repository);
				const file = await ask('GET', pathOf(fileId), {}, { fileId });
				if (file.source !== 'local') throw refused("Only one of the person's own files can be proposed. Copy the snippets into one first.");
				withSnippets(file);
				if (!file.matches.length) throw refused(`${file.name} has no snippets to propose.`);
				if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) throw refused('A package name is lowercase letters, digits and dashes, 80 characters or fewer.');
				if (!oneLine(summary, 100)) throw refused('Write a one-line summary, 100 characters or fewer.');
				const isNew = !team.packages.some((item) => item.name === name);
				if (isNew) {
					if (!oneLine(title, 100)) throw refused('A new package needs a `title`: one line, 100 characters or fewer.');
					if (typeof description !== 'string' || description.trim().length < 3 || description.trim().length > 1000) throw refused('A new package needs a `description` of 3 to 1000 characters.');
				}
				return {
					card: {
						kind: 'send',
						title: `Send ${file.name} to the team`,
						subject: file.name,
						fileId: file.id,
						fileName: file.name,
						after: file.text,
						lines: [`Repository: ${team.repository}`, `Package: ${name}${isNew ? ' (new)' : ''}`, ...(isNew ? [`Title: ${title}`, `Description: ${description}`] : []), `Summary: ${summary}`],
						warnings: ['This leaves your computer. Everyone who can read the repository will be able to read every snippet in this file.'],
					},
					made: { text: file.text, repository: team.repository, isNew },
				};
			},
			async apply({ args, made }) {
				// To the repository the card named, and no other. Another connected
				// since does not matter. Its own disconnected since does.
				const team = await stillConnected(made.repository);
				if (!team) throw stale();
				const file = await route('GET', pathOf(args.file_id));
				if (file.text !== made.text) throw stale();
				// A title and a description go only with a new package, where the card showed them.
				const naming = made.isNew ? { title: args.title, description: args.description } : {};
				const sent = await route('POST', '/team/proposals', { body: { fileId: args.file_id, package: args.package, summary: args.summary, ...naming, repository: team.id } });
				return {
					link: sent.compareUrl ?? null,
					message: `Sent as the branch ${sent.branch}. ${sent.compareUrl ? 'Open the page to start the pull request.' : "A person on the team opens the pull request on the repository's site."}`,
				};
			},
		},
	};

	// --- making a card -------------------------------------------------------

	// What the tools call in chat. A problem goes back to the model as words.
	// `origin` is the answer the call belongs to, when it belongs to one.
	async function add({ tool, args }, origin = null) {
		let built;
		try {
			built = await kinds[tool].build(args);
		} catch (error) {
			if (error?.code === 'REFUSED') return { error: error.message };
			throw error;
		}
		// Working a card out takes a moment, and the answer may have ended in it.
		// A card nobody asked for any more is not made.
		if (origin && !origin.isOpen()) return { error: ENDED };
		const id = randomBytes(6).toString('hex');
		const card = { id, tool, fileId: null, fileName: null, before: null, after: null, lines: [], warnings: [], ...built.card, status: 'pending', message: null, code: null, link: null };
		kept.set(id, { card, args: structuredClone(args), made: built.made ?? {}, busy: false });
		while (kept.size > limit) kept.delete(kept.keys().next().value);
		origin?.onCard?.({ ...card }, origin.turnId);
		onCard({ ...card }, origin?.turnId ?? null);
		return { id };
	}

	const changing = new Set(Object.keys(kinds));

	// The two ways a call arrives: from the tools the model sees in chat (their
	// input checks run here, in the app, whoever sent the call), and from a
	// command-line tool by way of the MCP server.
	function entry(origin) {
		const tools = createTools({ api: reach, propose: (proposal) => add(proposal, origin) });
		return {
			tools,
			async receive({ tool, args }) {
				if (!changing.has(tool)) {
					throw refused(tools.list().some((item) => item.name === tool) ? `${tool} does not change anything, so it is not a proposal.` : `There is no tool named ${tool}.`);
				}
				const result = await tools.call(tool, args);
				if (result.isError) throw refused(result.content[0].text);
				return { id: result.structuredContent.proposal_id };
			},
		};
	}
	const general = entry(null);

	const held = (id) => {
		const found = kept.get(id);
		if (!found) throw failed('NOT_FOUND', 'That proposal is no longer here. Ask again.');
		return found;
	};
	const update = (found, changes) => {
		found.card = { ...found.card, ...changes };
		return { ...found.card };
	};

	return {
		tools: general.tools,
		receive: general.receive,
		reach,

		// For one answer: its cards carry its name, and none is made once
		// `isOpen` says the answer is over.
		forTurn: ({ turnId, isOpen, onCard: tell }) => entry({ turnId, isOpen, onCard: tell }),

		get: (id) => (kept.has(id) ? { ...kept.get(id).card } : null),
		all: () => [...kept.values()].map((found) => ({ ...found.card })),

		dismiss(id) {
			const found = held(id);
			if (found.card.status !== 'pending') return { ...found.card };
			return update(found, { status: 'dismissed', message: null, code: null });
		},

		async apply(id) {
			const found = held(id);
			if (found.card.status !== 'pending') return { ...found.card };
			if (aiWrite() !== true) return update(found, { message: SWITCH_OFF, code: 'SWITCH_OFF' });
			update(found, { status: 'applying', message: null, code: null });
			try {
				const done = (await kinds[found.card.tool].apply(found)) ?? {};
				return update(found, { status: 'applied', message: done.message ?? null, link: done.link ?? null });
			} catch (error) {
				if (error?.code === 'STALE') return update(found, { status: 'stale', message: STALE, code: 'STALE' });
				// Anything else may pass: a full disk, a repository that could not
				// be reached. The card stays, with the app's own words on it.
				if (error?.described !== true) log(error);
				return update(found, { status: 'pending', message: error?.described ? error.message : 'Something went wrong inside the app.', code: error?.described ? error.code : 'ERROR' });
			}
		},
	};
}
