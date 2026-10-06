import http from 'node:http';
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

export function createApiServer({
	handle,
	getToken,
	log = console.error,
	maxBody = 4 * 1024 * 1024,
	headersTimeout = 10_000,
	requestTimeout = 30_000,
	checkInterval = 5_000,
}) {
	let server = null;
	let port = null;

	function reply(response, status, body, extra = {}) {
		const text = JSON.stringify(body);
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
			request.on('data', (chunk) => {
				size += chunk.length;
				if (size > maxBody) {
					reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
					return;
				}
				chunks.push(chunk);
			});
			request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
			const tooLarge = () => refuse(response, 413, 'TOO_LARGE', `The body is larger than ${Math.round(maxBody / 1024)} KB.`, { Connection: 'close' });
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

		start(wantedPort) {
			return new Promise((resolve, reject) => {
				const next = http.createServer({ connectionsCheckingInterval: checkInterval }, (request, response) => {
					onRequest(request, response).catch((error) => {
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
					reject(error.code === 'EADDRINUSE' ? Object.assign(new Error(`Port ${wantedPort} is in use.`), { code: 'PORT_IN_USE' }) : error);
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
