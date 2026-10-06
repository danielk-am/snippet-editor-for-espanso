import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { errorBody } from '../apiRouter.js';
import { createApiServer } from '../apiServer.js';
import { isPlainObject } from '../../shared/text.js';

// How an answer under way reaches the app.
//
// Claude Code and Codex start the MCP server themselves, as a program of its
// own, and that program has to read snippets and hand over proposals. It does
// not use "API for other tools": that switch is the person's, for tools they
// choose, and chat must work with it off.
//
// So each message gets a listener of its own, on 127.0.0.1, on a port the
// system picks, with a token made for it. Where it is and the token go into
// a file only the person can read, and the MCP server is told that file's
// path. When the answer ends, the listener closes and the file goes.
//
// The listener answers what the app can read, and "here is a proposal". It
// has no route that writes, so even a program that got hold of the token
// could change nothing through it.

const PROPOSALS = '/api/v1/chat/proposals';
const closed = () => ({ status: 405, body: errorBody('METHOD_NOT_ALLOWED', 'In chat a change is a proposal. Nothing is written through this listener.') });

export async function openChannel({ dir, router, onProposal, log = console.error }) {
	const token = randomBytes(32).toString('hex');

	async function handle({ method, path: target, query, body }) {
		if (target === PROPOSALS) {
			if (method !== 'POST') return closed();
			if (!isPlainObject(body) || typeof body.tool !== 'string' || !body.tool || !isPlainObject(body.args)) {
				return { status: 400, body: errorBody('INVALID', '`tool` must be text and `args` a mapping.') };
			}
			try {
				const { id } = await onProposal({ tool: body.tool, args: body.args });
				return { status: 201, body: { id } };
			} catch (error) {
				// What the app has against the proposal, in words for the model.
				if (error?.code === 'REFUSED') return { status: 422, body: errorBody('REFUSED', error.message) };
				throw error;
			}
		}
		if (method === 'GET') return router({ method, path: target, query });
		return closed();
	}

	const server = createApiServer({ handle, getToken: () => token, log });
	const { port } = await server.start(0);
	const file = path.join(dir, `chat-${randomBytes(8).toString('hex')}.json`);
	try {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(file, JSON.stringify({ port, token }), { mode: 0o600 });
	} catch (error) {
		await server.stop();
		throw error;
	}

	return {
		file,
		port,
		async close() {
			await server.stop();
			await fs.rm(file, { force: true });
		},
	};
}
