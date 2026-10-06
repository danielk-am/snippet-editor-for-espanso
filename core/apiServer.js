import { createHmac } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { errorBody } from './apiRouter.js';
import { tokensMatch } from './apiToken.js';
import { isPlainObject } from '../shared/text.js';

// The HTTP door to the router, for other tools on this computer. It listens
// on 127.0.0.1 only and lets a request through to the router only after
// three checks, in this order:
//
//   1. Host is this listener by name. A web page that points its own domain
//      at 127.0.0.1 (DNS rebinding) arrives with that domain here.
//   2. A browser did not make it. Browsers add Origin to anything that can
//      change data, and Sec-Fetch-Site to everything, including the plain
//      GET behind an image tag. Scripts send neither.
//   3. The token is right.
//
// The token is the real lock; the first two keep web pages from even trying.
// It sends no cross-origin headers, so a browser could not read a reply even
// if a request got this far.

const LOOPBACK = '127.0.0.1';

// Whether something already accepts connections on this port, on this computer.
function answers(port) {
	return new Promise((resolve) => {
		const socket = net.connect({ port, host: LOOPBACK });
		const done = (result) => {
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(1000, () => done(false));
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

// How much one request may send and how long it may take.
export const LIMITS = { maxBody: 4 * 1024 * 1024, headersTimeout: 10_000, requestTimeout: 30_000 };

// JSON has no way to write a number that is not finite, or a list or
// mapping that contains itself, and YAML allows both. Sending such a value
// altered would hand the caller data that is not in the file, so it is
// never sent altered. A file that holds one is marked and listed without
// its snippets (below); any other reply that holds one is refused whole.
function toJson(body) {
	try {
		return JSON.stringify(body, (key, value) => {
			if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('not finite');
			return value;
		});
	} catch (error) {
		if (error instanceof TypeError) return null;
		throw error;
	}
}

const NOT_CARRIED =
	'This file holds a value JSON cannot carry (a number that is not finite, or a list or mapping that contains itself), so its snippets are not listed here. Its text can still be read.';

// One odd file must not hide all the others. Where a reply is a file, a
// list of files or a list of search hits, the part that cannot be carried
// is marked or left out, and the rest goes through untouched.
function soften(body) {
	const file = (record) =>
		isPlainObject(record) && Array.isArray(record.matches) && toJson(record.matches) === null
			? { ...record, matchCount: null, parseErrors: [...(Array.isArray(record.parseErrors) ? record.parseErrors : []), NOT_CARRIED], matches: null, notCarried: true }
			: record;
	const groups = (list) => (Array.isArray(list) ? list.map((group) => (isPlainObject(group) && Array.isArray(group.files) ? { ...group, files: group.files.map(file) } : group)) : list);
	if (Array.isArray(body)) return body.filter((hit) => toJson(hit) !== null);
	if (!isPlainObject(body)) return body;
	const next = file(body);
	return {
		...next,
		...(Array.isArray(next.files) ? { files: next.files.map(file) } : {}),
		...('packages' in next ? { packages: groups(next.packages) } : {}),
		...('team' in next ? { team: groups(next.team) } : {}),
	};
}

// A reply as it is sent: its status, and its body as JSON. The window's
// channel has no need of this, but a caller inside the app that wants the
// same data an HTTP caller gets (the chat's tools) asks for it here.
export function carried(status, body) {
	const text = toJson(body) ?? toJson(soften(body));
	if (text !== null) return { status, text };
	return { status: 422, text: JSON.stringify(errorBody('UNREPRESENTABLE', 'This reply holds a value JSON cannot carry: a number that is not finite, or a list or mapping that contains itself. Change it in the app, in the raw YAML.')) };
}

export function createApiServer({
	handle,
	getToken,
	log = console.error,
	maxBody = LIMITS.maxBody,
	headersTimeout = LIMITS.headersTimeout,
	requestTimeout = LIMITS.requestTimeout,
	checkInterval = 5_000,
}) {
	let server = null;
	let port = null;

	function reply(response, status, body, extra = {}) {
		const { text, ...sent } = carried(status, body);
		status = sent.status;
		response.writeHead(status, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Length': Buffer.byteLength(text),
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			...extra,
		});
		response.end(text);
	}

	const refuse = (response, status, code, message, extra) => reply(response, status, errorBody(code, message), extra);

	function readBody(request) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			let size = 0;
			// Past the limit the rest is read and dropped, not kept. Hanging up
			// at once would leave the sender with a broken connection in place
			// of its answer; the request timeout bounds how long this can go on.
			request.on('data', (chunk) => {
				size += chunk.length;
				if (size > maxBody) chunks.length = 0;
				else chunks.push(chunk);
			});
			request.on('end', () => {
				if (size > maxBody) reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
				else resolve(Buffer.concat(chunks).toString('utf8'));
			});
			request.on('error', reject);
		});
	}

	async function onRequest(request, response) {
		const host = request.headers.host;
		if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) {
			return refuse(response, 403, 'FORBIDDEN', 'This API answers only requests addressed to this computer.');
		}
		if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) {
			return refuse(response, 403, 'FORBIDDEN', 'This API does not answer web pages.');
		}

		// The one thing answered without the token: proof that this listener
		// holds it. A caller sends a number of its own choosing and gets back a
		// keyed digest of it, which only the holder of the token can make. So a
		// caller can check who is listening before it sends the token at all.
		// Another program can take this port while the app is closed.
		if (request.method === 'GET' && request.url.startsWith('/api/v1/proof?')) {
			const nonce = request.url.slice('/api/v1/proof?nonce='.length);
			if (!request.url.startsWith('/api/v1/proof?nonce=') || !/^[a-f0-9]{32,64}$/.test(nonce)) {
				return refuse(response, 400, 'INVALID', '`nonce` must be 32 to 64 characters, 0 to 9 and a to f.');
			}
			return reply(response, 200, { proof: createHmac('sha256', String(await getToken())).update(nonce).digest('hex') });
		}
		const header = request.headers.authorization ?? '';
		const given = header.startsWith('Bearer ') ? header.slice(7) : null;
		if (!tokensMatch(given, await getToken())) {
			return refuse(response, 401, 'UNAUTHORIZED', 'Send the API token as "Authorization: Bearer <token>". Copy it from Settings.', {
				'WWW-Authenticate': 'Bearer',
			});
		}

		let url;
		try {
			url = new URL(request.url, `http://${LOOPBACK}:${port}`);
		} catch {
			return refuse(response, 400, 'INVALID', 'That address could not be read.');
		}

		let body;
		if (request.method === 'POST' || request.method === 'PUT') {
			const tooLarge = () => refuse(response, 413, 'TOO_LARGE', `The body is larger than ${Math.round(maxBody / 1024)} KB.`);
			const type = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
			if (type !== 'application/json') {
				return refuse(response, 415, 'UNSUPPORTED_TYPE', 'Send the body as JSON, with "Content-Type: application/json".');
			}
			let text;
			try {
				text = await readBody(request);
			} catch (error) {
				if (error.code === 'TOO_LARGE') return tooLarge();
				throw error;
			}
			try {
				body = JSON.parse(text);
			} catch {
				return refuse(response, 400, 'INVALID', 'The body is not valid JSON.');
			}
			if (!isPlainObject(body)) return refuse(response, 400, 'INVALID', 'The body must be a JSON object.');
		}

		const result = await handle({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
		reply(response, result.status, result.body);
	}

	return {
		get running() {
			return server !== null;
		},
		get port() {
			return port;
		},

		async start(wantedPort) {
			const inUse = () => Object.assign(new Error(`Port ${wantedPort} is in use.`), { code: 'PORT_IN_USE' });
			// A program listening on every address does not stop this one from
			// opening the same port on 127.0.0.1 alone, and would then lose its
			// local callers to it. So ask first whether anything answers there.
			if (wantedPort !== 0 && (await answers(wantedPort))) throw inUse();
			return new Promise((resolve, reject) => {
				const next = http.createServer({ connectionsCheckingInterval: checkInterval }, (request, response) => {
					onRequest(request, response).catch((error) => {
						// A sender that hung up partway is not a fault of the app.
						if (error?.code === 'ECONNRESET') return response.destroy();
						log(error);
						if (response.headersSent) response.destroy();
						else refuse(response, 500, 'ERROR', 'Something went wrong inside the app.');
					});
				});
				next.headersTimeout = headersTimeout;
				next.requestTimeout = requestTimeout;
				next.keepAliveTimeout = 5_000;
				// Before the port opens this fails the start. Afterwards nobody is
				// waiting, and the handler keeps a late error from stopping the app.
				next.on('error', (error) => {
					reject(error.code === 'EADDRINUSE' ? inUse() : error);
				});
				next.listen(wantedPort, LOOPBACK, () => {
					server = next;
					port = next.address().port;
					resolve({ port, address: next.address().address });
				});
			});
		},

		async stop() {
			if (!server) return;
			const closing = server;
			server = null;
			port = null;
			closing.closeAllConnections();
			await new Promise((resolve) => closing.close(resolve));
		},
	};
}
