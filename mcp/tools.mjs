// The twelve tools an AI tool gets. Each is shaped around a job, checks its
// own input, and turns one or two calls to the app's API into a small reply.
//
// Three rules hold for all of them:
//   - A reply is at most 25,000 characters, and says so when it was cut.
//   - A failure is a sentence that says what was wrong and what to call next.
//   - The seven tools that change something refuse unless the person has
//     switched on "Let AI tools change snippets" in the app.

const MAX_REPLY = 25_000;
const SWITCHED_OFF = 'Changing snippets is switched off. Ask the person to switch on "Let AI tools change snippets" in Snippet Editor\'s Settings, then try again.';
const LIST_FILES = 'Call snippets_list_files to see the files and their ids.';
const consent = (what) => `${what} would run a command on the person's computer each time it is used. Ask the person first. If they agree, call again with accept_commands set to true.`;

class ToolError extends Error {}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '');

// --- inputs ----------------------------------------------------------------

const text = (description, extra = {}) => ({ type: 'string', minLength: 1, description, ...extra });
const whole = (description, minimum, maximum) => ({ type: 'integer', minimum, ...(maximum === undefined ? {} : { maximum }), description });

const FILE_ID = text('The id of a file, from snippets_list_files or snippets_search. Examples: "local:base.yml" for one of the person\'s own files, "package:goodbyes:package.yml", "team:support:replies.yml".');
const VERSION = text('The `version` from your last snippets_get_file or snippets_get_snippet of this file. It proves you saw the file as it is now. Example: "3f2a9c0d1e4b5a6978c0d1e2".');
const INDEX = whole('The position of the snippet in its file, counting from 0. Example: 0.', 0);
const SNIPPET = {
	type: 'object',
	description:
		'The snippet, as Espanso keys. Give `trigger` (or `triggers`, a list, or `regex`) and what it expands to: `replace`, or `markdown`, `html`, `form` or `image_path`. Optional keys include `label`, `word`, `propagate_case` and `vars`. Example: {"trigger": ":sig", "replace": "Best,\\nSam"}.',
};
const LIMIT = whole('How many items to return, from 1 to 200. Default 50.', 1, 200);
const OFFSET = whole('How many items to skip, for the next page. Use `next_offset` from the last reply. Default 0.', 0);
const ACCEPT = { type: 'boolean', description: 'Pass true only after the person has agreed to a snippet that runs a command (a variable of type shell or script). Example: true.' };

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

function problemWith(inputSchema, args) {
	const properties = inputSchema.properties;
	for (const key of Object.keys(args)) {
		if (!Object.hasOwn(properties, key)) return `Unknown input \`${key}\`. This tool takes: ${Object.keys(properties).join(', ') || 'no inputs'}.`;
	}
	for (const key of inputSchema.required) {
		if (args[key] === undefined) return `Missing \`${key}\`. ${properties[key].description}`;
	}
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined) continue;
		const rule = properties[key];
		const hint = ` ${rule.description}`;
		if (rule.enum) {
			if (!rule.enum.includes(value)) return `\`${key}\` must be one of: ${rule.enum.join(', ')}.`;
		} else if (rule.type === 'string') {
			if (typeof value !== 'string') return `\`${key}\` must be text.${hint}`;
			if (rule.minLength && !value.trim()) return `\`${key}\` must not be empty.${hint}`;
		} else if (rule.type === 'integer') {
			const range = rule.maximum === undefined ? `a whole number, ${rule.minimum} or more` : `a whole number from ${rule.minimum} to ${rule.maximum}`;
			if (!Number.isInteger(value) || value < rule.minimum || (rule.maximum !== undefined && value > rule.maximum)) return `\`${key}\` must be ${range}.${hint}`;
		} else if (rule.type === 'boolean') {
			if (typeof value !== 'boolean') return `\`${key}\` must be true or false.${hint}`;
		} else if (rule.type === 'object') {
			if (!isObject(value)) return `\`${key}\` must be an object of Espanso keys.${hint}`;
		}
	}
	return null;
}

// --- shaping what comes back -----------------------------------------------

const triggersOf = (match) => {
	if (!isObject(match)) return [];
	if (Array.isArray(match.triggers)) return match.triggers.map(textOf).filter(Boolean);
	return [textOf(match.trigger) || textOf(match.regex)].filter(Boolean);
};

function previewOf(match) {
	if (!isObject(match)) return '';
	const body = ['replace', 'markdown', 'html', 'form', 'image_path'].map((key) => textOf(match[key])).find(Boolean) ?? '';
	return body.length > 120 ? `${body.slice(0, 117)}...` : body;
}

const cut = (text, most) => (text.length > most ? `${text.slice(0, most - 3)}...` : text);

// Espanso runs a `shell` or `script` variable as a command when the snippet
// is used. Writing one is never done without the person's say-so.
const runs = (vars) => Array.isArray(vars) && vars.some((item) => isObject(item) && (item.type === 'shell' || item.type === 'script'));
const fileRuns = (data) => isObject(data) && (runs(data.global_vars) || (Array.isArray(data.matches) && data.matches.some((match) => isObject(match) && runs(match.vars))));

function checkSnippet(snippet, accept) {
	if (!triggersOf(snippet).length) throw new ToolError('`snippet` needs a `trigger`, a list of `triggers`, or a `regex`. Example: {"trigger": ":sig", "replace": "Best,\\nSam"}.');
	if (runs(snippet.vars) && accept !== true) throw new ToolError(consent('This snippet'));
}

const brief = (match, index) => ({ index, triggers: triggersOf(match), label: isObject(match) ? textOf(match.label) : '', preview: previewOf(match) });

function page(items, { offset = 0, limit = 50 }) {
	const shown = items.slice(offset, offset + limit);
	const more = offset + shown.length < items.length;
	return { items: shown, total_count: items.length, has_more: more, next_offset: more ? offset + shown.length : null };
}

// Cuts a list at a whole item until the reply fits, and says where to go on.
function fit(data, key, { offset = 0, limit = 50 }) {
	const size = (value) => JSON.stringify(value).length;
	if (size(data) <= MAX_REPLY) return data;
	const items = data[key];
	let keep = items.length;
	const trimmed = (count) => ({
		...data,
		[key]: items.slice(0, count),
		has_more: true,
		next_offset: offset + count,
		note: `Cut to fit: this reply holds ${count} of the ${Math.min(limit, items.length)} asked for. Ask again with offset ${offset + count}, or use a smaller limit.`,
	});
	while (keep > 1 && size(trimmed(keep)) > MAX_REPLY) keep = Math.max(1, Math.floor(keep * 0.8));
	const result = trimmed(keep);
	if (size(result) > MAX_REPLY) {
		throw new ToolError(`The item at offset ${offset} is longer than a reply can carry. Continue with offset ${offset + 1}. To see that one, ask the person to open it in the app.`);
	}
	return result;
}

// --- what went wrong, in words that say what to do next --------------------

function explain(reply, { file, fileId, tool } = {}) {
	const { code, message } = reply.body?.error ?? {};
	const name = file ?? (fileId ? fileId.split(':').at(-1) : 'That file');
	switch (code) {
		case 'CONFLICT':
			return `${name} changed since you read it. Call snippets_get_file for ${fileId} again, look at what changed, then retry with the new version.`;
		case 'READ_ONLY':
			return `${name} is read-only: it belongs to a package, a team package, or is write-protected. To change a snippet from it, add your own copy to one of the person's files with snippets_add_snippet.`;
		case 'NOT_FOUND':
			return tool === 'team' ? `${message} Call snippets_list_team_packages to see what the repository offers.` : `${message} ${LIST_FILES}`;
		case 'INVALID_NAME':
			return fileId === undefined ? message : `That is not a file id. ${LIST_FILES}`;
		case 'EXISTS':
			return tool === 'team' ? `${message} Ask the person to move or remove that folder.` : `${message} Choose another name, or change the existing file.`;
		case 'PARSE_ERROR':
			return `That YAML has errors, so nothing was saved: ${message}`;
		case 'NOT_CONNECTED':
			return 'No team repository is connected. Ask the person to connect one in the app, under Settings.';
		case 'UNREPRESENTABLE':
			return 'That holds a value that cannot be sent here: a number that is not finite, or a list or mapping that contains itself. Ask the person to open it in the app.';
		case 'INVALID':
		case 'TOO_LARGE':
		case 'GIT_FAILED':
			return message;
		default:
			return `The app could not do that: ${message ?? `it answered ${reply.status}`}.`;
	}
}

export function createTools({ api }) {
	const ask = async (method, path, options, context) => {
		const reply = await api.request(method, path, options);
		if (reply.status >= 400) throw new ToolError(explain(reply, context));
		return reply.body;
	};
	const filePath = (fileId) => `/files/${encodeURIComponent(fileId)}`;
	const readFile = (fileId) => ask('GET', filePath(fileId), {}, { fileId });
	const head = (file) => ({
		file_id: file.id,
		name: file.name,
		source: file.source,
		...(file.package ? { package: file.package } : {}),
		description: cut(textOf(file.description), 300),
		prefix: cut(textOf(file.prefix), 40),
		read_only: file.readOnly,
	});
	// Why a file's snippets are not listed, and what can still be done.
	const broken = (file) =>
		file.unreadable
			? `${file.name} could not be opened: ${file.parseErrors?.[0] ?? 'no detail'} It can only be changed outside this app.`
			: file.notCarried
				? file.parseErrors.at(-1)
				: `${file.name} has YAML errors: ${file.parseErrors?.[0] ?? 'no detail'}`;
	const hint = (file) => (file.unreadable ? '' : ' Read it with snippets_get_file and detail "raw" to see the text.');

	const tools = [
		{
			name: 'snippets_search',
			title: 'Search snippets',
			description:
				'Find Espanso snippets by words in their trigger, label, search terms or the text they expand to. Searches every file: the person\'s own, installed packages and team packages. Use this first when you know what a snippet says or does but not where it lives. Returns matches with their file id and position, which the other tools take. `preview` is the text a snippet expands to, cut to 120 characters and ending in "..." when it is longer: read the whole snippet with snippets_get_snippet. Use snippets_list_files instead to see what files exist.',
			inputSchema: schema({ query: text('Words to look for. All must appear. A trigger works too. Examples: "refund", ":sig".'), limit: LIMIT, offset: OFFSET }, ['query']),
			async run({ query, limit = 50, offset = 0 }) {
				const hits = await ask('GET', '/search', { query: { q: query, limit: 1000 } });
				const found = hits.map((hit) => ({ file_id: hit.fileId, file: hit.fileName, source: hit.source, ...(hit.package ? { package: hit.package } : {}), ...brief(hit.match, hit.index) }));
				const data = fit(page(found, { offset, limit }), 'items', { offset, limit });
				if (!found.length) data.note = 'No snippets match. Try fewer or different words: search looks at triggers, labels, search terms and the text a snippet expands to.';
				// The app returns 1000 hits at most.
				if (hits.length === 1000) data.note = 'At least 1000 snippets match, and only the first 1000 can be reached. Narrow the search.';
				return data;
			},
		},
		{
			name: 'snippets_list_files',
			title: 'List match files',
			description:
				'List the Espanso match files: the person\'s own (source "local"), files from installed packages ("package") and from team packages ("team"). Use it to learn file ids, how many snippets each file holds, which are read-only, and which have problems. A "package" was installed by Espanso and a "team" package by this app from the team repository: the two are separate, even when they share a name. `total_count` counts files, not snippets. Use snippets_search instead to find a particular snippet.',
			inputSchema: schema({ source: { enum: ['local', 'package', 'team'], description: 'Keep to one source. Leave out for all three. Example: "local".' }, limit: LIMIT, offset: OFFSET }),
			async run({ source, limit = 50, offset = 0 }) {
				const state = await ask('GET', '/state');
				const files = [...state.files, ...[...state.packages, ...state.team].flatMap((pkg) => pkg.files)].filter((file) => !source || file.source === source);
				const items = files.map((file) => ({ ...head(file), snippet_count: file.matchCount, ...(file.matches === null ? { problem: broken(file) } : {}) }));
				// The header fields in a fixed order, with the count before read_only.
				const ordered = items.map(({ read_only: readOnly, ...rest }) => ({ ...rest, read_only: readOnly }));
				const data = fit(page(ordered, { offset, limit }), 'items', { offset, limit });
				if (state.error) data.note = state.error;
				else if (state.exists === false) data.note = 'The match folder does not exist yet. Creating a file creates it.';
				return data;
			},
		},
		{
			name: 'snippets_get_file',
			title: 'Read a match file',
			description:
'Read one match file and get its `version`, which every change to that file needs. detail "summary" (the default) lists each snippet\'s position, triggers, label and a short preview. "full" gives each snippet whole, as Espanso keys. "raw" gives the YAML text itself, with its comments, imports and global variables. In "summary" and "full", long files come back in pages: use `limit` and `offset`, and a `preview` is cut to 120 characters. In "raw", a long file comes back in parts: `offset` then counts characters, each part says where the next starts, and the `version` comes only with the last part, so the whole text has been read before anything can be sent back.',
			inputSchema: schema(
				{
					file_id: FILE_ID,
					detail: { enum: ['summary', 'full', 'raw'], description: 'How much to return. Default "summary". Example: "full".' },
					limit: LIMIT,
					offset: whole('For "summary" and "full": how many snippets to skip. For "raw": how many characters to skip. Use `next_offset` from the last reply. Default 0.', 0),
				},
				['file_id']
			),
			async run({ file_id: fileId, detail = 'summary', limit = 50, offset = 0 }) {
				const file = await readFile(fileId);
				const base = { ...head(file), version: file.version, snippet_count: file.matchCount };
				if (detail === 'raw') {
					const { version, ...unversioned } = base;
					if (file.unreadable) return { ...unversioned, problem: broken(file) };
					const total = file.text.length;
					const part = (end) => {
						const more = end < total;
						return {
							// The version unlocks a write. It is held back until the last
							// part, so a file is never replaced by its first part alone.
							...(more ? unversioned : base),
							yaml: file.text.slice(offset, end),
							total_characters: total,
							has_more: more,
							next_offset: more ? end : null,
							...(more || offset > 0
								? { note: `This is characters ${offset} to ${end} of ${total}. ${more ? `Read on with offset ${end}. The version comes with the last part.` : 'This is the last part.'} Join every part, in order, before sending the file back with snippets_replace_file_yaml.` }
								: {}),
						};
					};
					let end = total;
					while (end > offset && JSON.stringify(part(end)).length > MAX_REPLY) end = offset + Math.floor((end - offset) * 0.8);
					return part(end);
				}
				if (file.matches === null) {
					return { ...base, problem: `${broken(file)}${hint(file)}`, snippets: [], has_more: false, next_offset: null };
				}
				const all = file.matches.map((match, index) => (detail === 'full' ? { index, snippet: match } : brief(match, index)));
				const { items, total_count: total, ...paging } = page(all, { offset, limit });
				return fit({ ...base, snippets: items, ...paging }, 'snippets', { offset, limit });
			},
		},
		{
			name: 'snippets_get_snippet',
			title: 'Read one snippet',
			description:
				'Read one snippet whole, as Espanso keys, together with the `version` of its file. Use it before changing or deleting a snippet, so you work from what is there now. Takes the file id and the snippet\'s position, as given by snippets_search or snippets_get_file. A file\'s `global_vars` are not part of any one snippet: read them with snippets_get_file and detail "raw".',
			inputSchema: schema({ file_id: FILE_ID, index: INDEX }, ['file_id', 'index']),
			async run({ file_id: fileId, index }) {
				const file = await readFile(fileId);
				if (file.matches === null) throw new ToolError(`${broken(file)}${hint(file)}`);
				if (!file.matches.length) throw new ToolError(`${file.name} has no snippets.`);
				if (index >= file.matches.length) {
					throw new ToolError(`${file.name} has ${file.matches.length} snippets, at positions 0 to ${file.matches.length - 1}. Call snippets_get_file to see them.`);
				}
				const data = { file_id: file.id, file: file.name, read_only: file.readOnly, version: file.version, index, snippet: file.matches[index] };
				if (JSON.stringify(data).length > MAX_REPLY) throw new ToolError('This snippet is longer than a reply can carry. Ask the person to open it in the app.');
				return data;
			},
		},
		{
			name: 'snippets_list_team_packages',
			title: 'List team packages',
			description:
				'Show the team repository the app is connected to and the packages it offers: which are installed, which have an update, and which run commands when their snippets are used. Use it before snippets_install_team_package or snippets_propose_to_team. `snippet_count` is what the repository offers now. `installed_only` names packages that are installed but that the repository no longer offers. Team packages are separate from packages Espanso installed, even when they share a name. If no repository is connected, it says so.',
			inputSchema: schema({ limit: LIMIT, offset: OFFSET }),
			async run({ limit = 50, offset = 0 }) {
				const team = await ask('GET', '/team');
				const { items, ...paging } = page(
					team.packages.map((pkg) => ({
						name: pkg.name,
						title: pkg.title,
						description: pkg.description,
						snippet_count: pkg.matchCount,
						installed: pkg.installed,
						update_available: pkg.updateAvailable,
						runs_commands: pkg.runsCommands,
					})),
					{ offset, limit }
				);
				const data = fit({ connected: team.connected, repository: team.repository, packages: items, ...paging, installed_only: team.installedOnly.map((item) => item.name) }, 'packages', { offset, limit });
				if (!team.connected) data.note = team.problem || 'No team repository is connected. The person can connect one in the app, under Settings.';
				else if (team.problem) data.note = `${team.problem} What is listed is from the last time the repository could be reached.`;
				return data;
			},
		},
		{
			name: 'snippets_add_snippet',
			title: 'Add a snippet',
			write: true,
			description:
				'Add a new snippet to one of the person\'s own files. Read the file first with snippets_get_file and pass its `version`. The snippet goes at the end unless you give `index`. Returns the new position and the file\'s new version. Fails on a read-only file, and when the file changed since you read it.',
			inputSchema: schema(
				{ file_id: FILE_ID, snippet: SNIPPET, version: VERSION, index: whole('Where to put it, counting from 0. Leave out to add at the end. Example: 0.', 0), accept_commands: ACCEPT },
				['file_id', 'snippet', 'version']
			),
			async run({ file_id: fileId, snippet, version, index, accept_commands: accept }) {
				checkSnippet(snippet, accept);
				const file = await ask('POST', `${filePath(fileId)}/snippets`, { body: { match: snippet, index, version } }, { fileId });
				return { file_id: file.id, index: Math.min(index ?? file.matches.length - 1, file.matches.length - 1), snippet_count: file.matches.length, version: file.version };
			},
		},
		{
			name: 'snippets_update_snippet',
			title: 'Change a snippet',
			write: true,
			description:
				'Replace one snippet in one of the person\'s own files with the one you give. Read it first with snippets_get_snippet, change what you need in that object, and send the whole snippet back with the file\'s `version`. Keys you leave out are removed from the snippet. Nothing else in the file is touched.',
			destructive: true,
			inputSchema: schema({ file_id: FILE_ID, index: INDEX, snippet: SNIPPET, version: VERSION, accept_commands: ACCEPT }, ['file_id', 'index', 'snippet', 'version']),
			async run({ file_id: fileId, index, snippet, version, accept_commands: accept }) {
				checkSnippet(snippet, accept);
				const file = await ask('PUT', `${filePath(fileId)}/snippets/${index}`, { body: { match: snippet, version } }, { fileId });
				return { file_id: file.id, index, snippet_count: file.matches.length, version: file.version };
			},
		},
		{
			name: 'snippets_delete_snippet',
			title: 'Delete a snippet',
			write: true,
			destructive: true,
			description:
				'Remove one snippet from one of the person\'s own files. Check with snippets_get_snippet that the position holds the snippet you mean, then pass the file\'s `version`. The app keeps a backup of the file as it was. Snippets after it move up one position.',
			inputSchema: schema({ file_id: FILE_ID, index: INDEX, version: VERSION }, ['file_id', 'index', 'version']),
			async run({ file_id: fileId, index, version }) {
				const file = await ask('DELETE', `${filePath(fileId)}/snippets/${index}`, { query: { version } }, { fileId });
				return { file_id: file.id, deleted_index: index, snippet_count: file.matches.length, version: file.version };
			},
		},
		{
			name: 'snippets_create_file',
			title: 'Create a match file',
			write: true,
			description:
				'Create a new, empty match file in the person\'s Espanso match folder. Use it when a group of snippets deserves a file of its own. Then add snippets to it with snippets_add_snippet, using the `version` this returns. Fails if a file of that name exists.',
			inputSchema: schema(
				{
					name: text('The file name, ending in .yml, with no folders. A name starting with _ is loaded only when another file imports it. Example: "work.yml".'),
					description: { type: 'string', description: 'What the file is for. Kept as its first comment line. Example: "Replies for the work inbox".' },
					prefix: { type: 'string', description: 'A prefix the person starts this file\'s triggers with. Example: ":".' },
				},
				['name']
			),
			async run({ name, description, prefix }) {
				const file = await ask('POST', '/files', { body: { name, description, prefix } });
				return { file_id: file.id, name: file.name, version: file.version };
			},
		},
		{
			name: 'snippets_replace_file_yaml',
			title: 'Replace a file\'s YAML',
			write: true,
			destructive: true,
			description:
				'Replace the whole YAML text of one of the person\'s own files. Use it only for what the snippet tools cannot do: comments, `imports`, `global_vars` and other keys beside `matches`. Read the text first with snippets_get_file and detail "raw", change it, and send all of it back with the file\'s `version`. YAML that does not parse is refused. The app keeps a backup.',
			inputSchema: schema(
				{ file_id: FILE_ID, yaml: text('The complete new text of the file. Example: "matches:\\n  - trigger: \\":hi\\"\\n    replace: \\"Hello\\"\\n".'), version: VERSION, accept_commands: ACCEPT },
				['file_id', 'yaml', 'version']
			),
			async run({ file_id: fileId, yaml, version, accept_commands: accept }) {
				if (accept !== true) {
					// The app reads the YAML, so this file needs no parser of its own.
					const parsed = await api.request('POST', '/yaml/parse', { body: { text: yaml } });
					if (parsed.status === 413 || parsed.body?.error?.code === 'UNREPRESENTABLE') {
						throw new ToolError(
							'This YAML could not be checked for snippets that run commands: it is too long, or holds a value that cannot be sent. Ask the person first. If they agree, call again with accept_commands set to true.'
						);
					}
					if (parsed.status === 200 && fileRuns(parsed.body.value)) throw new ToolError(consent('This file'));
				}
				const file = await ask('PUT', `${filePath(fileId)}/raw`, { body: { text: yaml, version } }, { fileId });
				return { file_id: file.id, snippet_count: file.matchCount, version: file.version };
			},
		},
		{
			name: 'snippets_install_team_package',
			title: 'Install a team package',
			write: true,
			destructive: true,
			description:
				'Install a package from the connected team repository, or update an installed one to what the repository has now. Its snippets then work in Espanso and show as read-only files with source "team". A package that runs commands is refused until the person agrees and you pass accept_commands. See what is on offer with snippets_list_team_packages.',
			inputSchema: schema(
				{
					name: text('The package name, from snippets_list_team_packages. Example: "goodbyes".'),
					accept_commands: { type: 'boolean', description: 'Pass true only after the person has agreed to install a package that runs commands. Example: true.' },
				},
				['name']
			),
			async run({ name, accept_commands: accept }) {
				const reply = await api.request('PUT', `/team/packages/${encodeURIComponent(name)}/installed`, { body: { acceptCommands: accept }, timeout: 150_000 });
				if (reply.status >= 400) {
					if (/runs commands/.test(reply.body?.error?.message ?? '')) {
						throw new ToolError(`The ${name} package runs commands on the person's computer when its snippets are used. Ask the person whether to install it. If they agree, call again with accept_commands set to true.`);
					}
					throw new ToolError(explain(reply, { tool: 'team' }));
				}
				const pkg = reply.body.packages.find((item) => item.name === name);
				return { name, installed: pkg?.installed ?? true, update_available: pkg?.updateAvailable ?? false };
			},
		},
		{
			name: 'snippets_propose_to_team',
			title: 'Propose a file to the team',
			write: true,
			openWorld: true,
			description:
				'Send one of the person\'s own files to a package in the team repository, as a new branch on GitHub that the team can review. This leaves the computer: everyone who can read the repository will be able to read every snippet in the file, so ask the person first. It never changes the repository\'s main branch. For a package that does not exist yet, give `title` and `description` too.',
			inputSchema: schema(
				{
					file_id: FILE_ID,
					package: text('The package to send it to, existing or new: lowercase letters, digits and dashes. Example: "goodbyes".'),
					summary: text('One line the team will see on the pull request. Example: "Add shipping replies".'),
					title: { type: 'string', description: 'For a new package only: its title. Example: "Shipping replies".' },
					description: { type: 'string', description: 'For a new package only: what it is for, in 3 to 1000 characters. Example: "Replies about shipping and returns".' },
				},
				['file_id', 'package', 'summary']
			),
			async run({ file_id: fileId, package: name, summary, title, description }) {
				// Read first: a file that is not there is then reported as a file.
				await readFile(fileId);
				const sent = await ask('POST', '/team/proposals', { body: { fileId, package: name, summary, title, description }, timeout: 150_000 }, { fileId, tool: 'team' });
				return {
					branch: sent.branch,
					pull_request_url: sent.compareUrl,
					created_package: sent.created,
					note: sent.compareUrl ? 'The branch is pushed. Give the person this link: opening it starts the pull request.' : "The branch is pushed. A person on the team opens the pull request on the repository's site.",
				};
			},
		},
	];

	const definitions = tools.map((tool) => ({
		name: tool.name,
		title: tool.title,
		description: tool.description,
		inputSchema: tool.inputSchema,
		annotations: {
			readOnlyHint: !tool.write,
			destructiveHint: Boolean(tool.destructive),
			idempotentHint: !tool.write,
			openWorldHint: Boolean(tool.openWorld),
		},
	}));

	const failed = (message) => ({ content: [{ type: 'text', text: message.length > 1500 ? `${message.slice(0, 1500)}... (cut: ${message.length} characters in all)` : message }], isError: true });

	return {
		list: () => definitions,

		// A result for the protocol to send, or null for a tool that is not here.
		async call(name, args) {
			const tool = tools.find((candidate) => candidate.name === name);
			if (!tool) return null;
			const problem = problemWith(tool.inputSchema, args);
			if (problem) return failed(problem);
			try {
				if (tool.write && !(await api.settings()).aiWrite) return failed(SWITCHED_OFF);
				const data = await tool.run(args);
				return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false };
			} catch (error) {
				if (error instanceof ToolError || error?.code === 'UNREACHABLE') return failed(error.message);
				throw error;
			}
		},
	};
}
