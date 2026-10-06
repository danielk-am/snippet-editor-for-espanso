import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// The secret other tools send to use the HTTP API. It lives in a file only
// the owner can read, so a script on this computer can pick it up and a web
// page cannot.

const SHAPE = /^[a-f0-9]{64}$/;

async function write(file, token) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, token + '\n', { mode: 0o600 });
	// An existing file keeps its old mode on write, so set it outright.
	await fs.chmod(file, 0o600);
	return token;
}

export async function replaceToken(file) {
	return write(file, randomBytes(32).toString('hex'));
}

export async function loadToken(file) {
	try {
		const token = (await fs.readFile(file, 'utf8')).trim();
		if (SHAPE.test(token)) return token;
	} catch {
		// Missing or unreadable: make a new one below.
	}
	return replaceToken(file);
}

// Compared in constant time, so the answer does not reveal how much matched.
export function tokensMatch(given, expected) {
	if (typeof given !== 'string' || typeof expected !== 'string') return false;
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
