import http from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { createOllama } from '../../core/chat/ollama.js';

// A stand-in for Ollama, answering in the shapes its API reference gives.
// Ollama is not installed on the computer this was built on.
export async function standIn(t, { answers = [], version = '0.12.3', models = ['qwen3:8b', 'gpt-oss:120b-cloud', 'llama3.2:latest'], chunkDelay = 0 } = {}) {
	const requests = [];
	const closed = [];
	const server = http.createServer(async (request, response) => {
		let text = '';
		for await (const chunk of request) text += chunk;
		const body = text ? JSON.parse(text) : null;
		requests.push({ method: request.method, url: request.url, body, headers: request.headers });
		response.on('close', () => closed.push(request.url));
		if (request.url === '/api/version') return response.end(JSON.stringify({ version }));
		if (request.url === '/api/tags') return response.end(JSON.stringify({ models: models.map((name) => ({ name, model: name, size: 1 })) }));
		if (request.url === '/api/chat') {
			const answer = answers.length > 1 ? answers.shift() : answers[0];
			if (answer.status) return response.writeHead(answer.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: answer.error }));
			response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
			for (const chunk of answer.chunks) {
				if (chunk === 'HANG') return;
				response.write(`${JSON.stringify(chunk)}\n`);
				if (chunkDelay) await wait(chunkDelay);
			}
			return response.end();
		}
		response.writeHead(404).end('{}');
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	return { port: server.address().port, requests, closed, ollama: createOllama({ port: server.address().port }) };
}

export const said = (content, extra = {}) => ({ model: 'm', created_at: 'now', message: { role: 'assistant', content, ...extra }, done: false });
export const END = { model: 'm', created_at: 'now', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' };
export const calls = (...list) => said('', { tool_calls: list.map(([name, args], index) => ({ type: 'function', function: { index, name, arguments: args } })) });
