import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Replace a file only after its complete contents have reached disk.
export async function atomicFile(file, text, mode = 0o600) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = path.join(path.dirname(file), `.snippet-editor-${randomBytes(8).toString('hex')}.tmp`);
	try {
		const handle = await fs.open(tmp, 'wx', mode);
		try {
			await handle.writeFile(text);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(tmp, file);
	} finally {
		await fs.rm(tmp, { force: true });
	}
}
