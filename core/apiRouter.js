import { parseDocument, stringify } from 'yaml';
import { stringifyMatch } from './matchFile.js';
import { repositoryName } from './teamAddress.js';
import { PACKAGE_NAME } from './teamRepo.js';
import { isPlainObject } from '../shared/text.js';

// The app's one contract. A request comes in as plain data, whichever way it
// travelled, and a reply goes out as plain data: the window's channel and the
// HTTP listener both call this and nothing else, so a route cannot behave
// differently for one of them.

const PREFIX = '/api/v1/';

const STATUS = {
	INVALID: 400,
	INVALID_NAME: 400,
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	READ_ONLY: 403,
	NOT_FOUND: 404,
	METHOD_NOT_ALLOWED: 405,
	AMBIGUOUS: 409,
	CONFLICT: 409,
	EXISTS: 409,
	NOT_CONNECTED: 409,
	TOO_LARGE: 413,
	UNSUPPORTED_TYPE: 415,
	PARSE_ERROR: 422,
	GIT_FAILED: 502,
};

// Failures of the disk itself. They are nobody's bad input, so they answer
// 500, but in words a person can act on and without the path Node puts in
// its own message.
const DISK = {
	ENOSPC: 'The disk is full, so nothing was saved.',
	EACCES: 'Permission was denied for that file or folder.',
	EPERM: 'Permission was denied for that file or folder.',
	EROFS: 'That folder is read-only.',
};

export const errorBody = (code, message) => ({ error: { code, message } });

const fail = (code, message) => Object.assign(new Error(message), { code });
const invalid = (message) => fail('INVALID', message);

// "local:base.yml", "package:goodbyes:package.yml" or
// "team:goodbyes:package.yml", as the store knows them. A package name never
// holds a colon, so the second colon ends it.
export function refFromId(id) {
	if (typeof id === 'string' && id.startsWith('local:')) return { source: 'local', name: id.slice(6) };
	const [source, name, ...rest] = typeof id === 'string' ? id.split(':') : [];
	if ((source === 'package' || source === 'team') && name && rest.length) return { source, package: name, name: rest.join(':') };
	throw fail('INVALID_NAME', 'That is not a file id. Use the `id` of a file from /state.');
}

// --- input checks -----------------------------------------------------------

const isText = (value) => typeof value === 'string';
const isPosition = (value) => Number.isInteger(value) && value >= 0;

function required(body, field, check, kind) {
	if (!isPlainObject(body) || !check(body[field])) throw invalid(`\`${field}\` must be ${kind}.`);
	return body[field];
}

function optional(body, field, check, kind) {
	if (body[field] === undefined) return undefined;
	if (!check(body[field])) throw invalid(`\`${field}\` must be ${kind}.`);
	return body[field];
}

const match = (body) => required(body, 'match', isPlainObject, 'a mapping of snippet keys');

// Digits only. A number parser would also take "0x1", "1e2" and " 2 ".
const isDigits = (text) => typeof text === 'string' && /^\d+$/.test(text);

function position(text) {
	if (!isDigits(text)) throw invalid('The snippet position in the path must be a whole number.');
	return Number(text);
}

// Checking YAML costs more than its length suggests, and the check runs in
// the app's one process, so a helper takes only as much as a person types.
const MAX_YAML_TEXT = 256 * 1024;

// A value nested deeper than the YAML writer can follow.
function written(write) {
	try {
		return write();
	} catch (error) {
		if (error instanceof RangeError) throw invalid('That value is nested too deeply to write as YAML.');
		throw error;
	}
}

// --- which team repository a request means -----------------------------------
//
// Several can be connected. A request names one by its `id`, from `GET team`.
// It may leave that out where only one could be meant. Where more than one
// could, it is refused and told which they are.

const noneConnected = () => fail('NOT_CONNECTED', 'No team repository is connected. Connect one in the app, under Settings.');

// The id a request's body names, or undefined when it names none.
const repositoryIn = (body) => (isPlainObject(body) ? optional(body, 'repository', isText, 'text') : undefined);

function repositoryWithId(service, id) {
	const team = service.team(id);
	if (!team) throw fail('NOT_FOUND', 'That repository is not connected.');
	return team;
}

const COUNTED = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

// What a caller is told when more than one repository could be meant.
// `listed` is each of them as { name, id }. It is written owner/repo with its
// id in brackets, which is what to send. The chat's cards say the same thing
// before a card is made, so the words are kept in one place.
export function whichRepository(listed, what) {
	const names = listed.map(({ name, id }) => `${name} (${id})`);
	return `${COUNTED[listed.length - 2]} repositories ${what}: ${names.slice(0, -1).join(', ')} and ${names.at(-1)}. Say which: set \`repository\` to one of the ids in brackets.`;
}

const ambiguous = (teams, what) => fail('AMBIGUOUS', whichRepository(teams.map((team) => ({ name: repositoryName(team.address), id: team.address.id })), what));

// Where a proposal goes when the request names no repository: to the only one.
function onlyRepository(service) {
	const teams = service.teams();
	if (!teams.length) throw noneConnected();
	if (teams.length > 1) throw ambiguous(teams, 'are connected');
	return teams[0];
}

// Where a package is installed from when the request names no repository:
// from the one that offers it.
async function repositoryOffering(service, name) {
	const teams = service.teams();
	if (!teams.length) throw noneConnected();
	// The only one connected answers for itself, whatever is wrong with the name.
	if (teams.length === 1) return teams[0];
	if (!PACKAGE_NAME.test(name)) throw invalid('A package name is lowercase letters, digits and dashes, 80 characters or fewer.');
	// What each offers is read from the app's copy of it. Nothing is fetched.
	const statuses = await Promise.all(teams.map((team) => team.status()));
	const offered = (index) => statuses[index].packages.find((pkg) => pkg.name === name);
	const offering = teams.filter((team, index) => offered(index));
	if (!offering.length) throw fail('NOT_FOUND', `No connected repository has a package named ${name}.`);
	if (offering.length === 1) return offering[0];
	// Several offer it. If one of them holds the name already, the request can
	// only be for that one: an update. Every other is refused while the name is
	// held. A damaged marker shows as installed in each, and then none holds it.
	const holding = teams.filter((team, index) => offered(index)?.installed);
	if (holding.length === 1) return holding[0];
	throw ambiguous(offering, `offer ${name}`);
}

// --- routes -----------------------------------------------------------------

const routes = [
	['GET', 'state', ({ service }) => service.state()],

	['GET', 'search', ({ service, query }) => {
		if (!isText(query.q)) throw invalid('`q` must be text.');
		if (query.limit === undefined) return service.store.search(query.q);
		const limit = isDigits(query.limit) ? Number(query.limit) : NaN;
		if (!(limit >= 1 && limit <= 1000)) throw invalid('`limit` must be a whole number from 1 to 1000.');
		return service.store.search(query.q, { limit });
	}],

	['POST', 'files', ({ service, body }) => service.store.createFile({
		name: required(body, 'name', isText, 'text'),
		description: optional(body, 'description', isText, 'text'),
		prefix: optional(body, 'prefix', isText, 'text'),
	}), 201],

	['GET', 'files/:id', ({ service, params }) => service.store.readFile(refFromId(params.id))],

	['DELETE', 'files/:id', ({ service, params, query }) => service.store.deleteFile(refFromId(params.id), { version: query.version })],

	['PUT', 'files/:id/details', ({ service, params, body }) => service.store.setHeader(refFromId(params.id), {
		description: required(body, 'description', isText, 'text'),
		prefix: required(body, 'prefix', isText, 'text'),
		version: body.version,
	})],

	['PUT', 'files/:id/raw', ({ service, params, body }) => service.store.saveRaw(refFromId(params.id), {
		text: required(body, 'text', isText, 'text'),
		version: body.version,
	})],

	['POST', 'files/:id/snippets', ({ service, params, body }) => service.store.createMatch(refFromId(params.id), {
		match: match(body),
		index: optional(body, 'index', isPosition, 'a whole number, zero or more'),
		version: body.version,
	}), 201],

	['PUT', 'files/:id/snippets/:index', ({ service, params, body }) => service.store.updateMatch(refFromId(params.id), {
		index: position(params.index),
		match: match(body),
		version: body.version,
	})],

	['DELETE', 'files/:id/snippets/:index', ({ service, params, query }) => service.store.deleteMatch(refFromId(params.id), {
		index: position(params.index),
		version: query.version,
	})],

	// --- team snippets ---------------------------------------------------------

	['GET', 'team', ({ service }) => service.teamStatus()],

	// Each of the next four answers what `GET team` answers: every connected
	// repository.

	// Fetches them all. One that cannot be fetched has that recorded on it,
	// where the status shows it, and the rest are still fetched.
	['POST', 'team/refresh', ({ service }) => {
		if (!service.teams().length) throw noneConnected();
		return service.refreshTeam();
	}],

	// Fetches one. If it cannot be fetched, that is the answer.
	['POST', 'team/repositories/:id/refresh', ({ service, params }) => service.refreshTeam(params.id)],

	['PUT', 'team/packages/:name/installed', async ({ service, params, body }) => {
		const id = repositoryIn(body);
		const team = id === undefined ? await repositoryOffering(service, params.name) : repositoryWithId(service, id);
		await team.install(params.name, { acceptCommands: isPlainObject(body) ? body.acceptCommands : undefined });
		return service.teamStatus();
	}],

	// A name is installed once, so removing needs no repository.
	['DELETE', 'team/packages/:name/installed', ({ service, params }) => service.removeTeamPackage(params.name)],

	['POST', 'team/proposals', async ({ service, body }) => {
		// Which repository comes first. Until it is known, nothing else in the
		// request is looked at and git is not run.
		const id = repositoryIn(body);
		const team = id === undefined ? onlyRepository(service) : repositoryWithId(service, id);
		const ref = refFromId(required(body, 'fileId', isText, 'text'));
		const input = {
			package: required(body, 'package', isText, 'text'),
			summary: required(body, 'summary', isText, 'text'),
			title: optional(body, 'title', isText, 'text'),
			description: optional(body, 'description', isText, 'text'),
		};
		if (ref.source !== 'local') throw invalid('Only one of your own files can be proposed. Copy the snippets into one first.');
		const file = await service.store.readFile(ref);
		if (file.matches === null) throw invalid(`${file.name} has YAML errors or could not be opened. Fix it before proposing it.`);
		if (!file.matches.length) throw invalid(`${file.name} has no snippets to propose.`);
		return team.propose({ ...input, fileName: file.name, text: file.text });
	}, 201],

	['POST', 'yaml/preview', ({ body }) => ({ yaml: written(() => stringifyMatch(match(body))) })],

	['POST', 'yaml/parse', ({ body }) => {
		const text = required(body, 'text', isText, 'text');
		if (text.length > MAX_YAML_TEXT) throw fail('TOO_LARGE', 'That is too much YAML to check at once (over 256 KB).');
		const doc = parseDocument(text);
		if (doc.errors.length) throw fail('PARSE_ERROR', doc.errors[0].message.split('\n')[0]);
		try {
			return { value: doc.toJS() ?? null };
		} catch (error) {
			// An alias with nothing to point at only fails when it is resolved.
			throw fail('PARSE_ERROR', String(error.message).split('\n')[0]);
		}
	}],

	['POST', 'yaml/stringify', ({ body }) => {
		if (!isPlainObject(body) || !('value' in body)) throw invalid('`value` is required.');
		return { yaml: written(() => stringify(body.value, { lineWidth: 0 })) };
	}],
].map(([method, pattern, handler, status = 200]) => ({ method, parts: pattern.split('/'), handler, status }));

function find(method, path) {
	if (typeof path !== 'string' || !path.startsWith(PREFIX)) throw fail('NOT_FOUND', 'There is nothing at that path. Routes start with /api/v1/.');
	let segments;
	try {
		segments = path.slice(PREFIX.length).split('/').map(decodeURIComponent);
	} catch {
		throw invalid('The path is not valid percent-encoding.');
	}

	let pathExists = false;
	for (const route of routes) {
		if (route.parts.length !== segments.length) continue;
		const params = {};
		const fits = route.parts.every((part, index) => {
			if (part.startsWith(':')) {
				params[part.slice(1)] = segments[index];
				return segments[index] !== '';
			}
			return part === segments[index];
		});
		if (!fits) continue;
		if (route.method === method) return { route, params };
		pathExists = true;
	}
	if (pathExists) throw fail('METHOD_NOT_ALLOWED', `${method} is not available on that path.`);
	throw fail('NOT_FOUND', 'There is nothing at that path.');
}

export function createRouter({ service, log = console.error }) {
	return async function handle({ method, path, query, body }) {
		try {
			const { route, params } = find(method, path);
			const result = await route.handler({ service, params, query: isPlainObject(query) ? query : {}, body });
			return { status: route.status, body: result };
		} catch (error) {
			const known = typeof error?.code === 'string' && Object.hasOwn(STATUS, error.code);
			if (known) return { status: STATUS[error.code], body: errorBody(error.code, error.message) };
			// Not one of ours: say so plainly and keep the detail in the log.
			log(error);
			const message = Object.hasOwn(DISK, error?.code ?? '') ? DISK[error.code] : 'Something went wrong inside the app.';
			return { status: 500, body: errorBody('ERROR', message) };
		}
	};
}
