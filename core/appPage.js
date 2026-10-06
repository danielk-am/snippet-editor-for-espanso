import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Whether a page URL is the given file on disk. The main process uses this
// to answer only its own page, so it has to hold on every system: Windows
// may report the same file with a different drive-letter or name case.
export function isSameFile(url, file, platform = process.platform) {
	const windows = platform === 'win32';
	let fromUrl;
	try {
		const parsed = new URL(url);
		// A host means a file on another machine, never the app's own.
		if (parsed.protocol !== 'file:' || parsed.host) return false;
		parsed.search = '';
		parsed.hash = '';
		fromUrl = fileURLToPath(parsed, { windows });
	} catch {
		return false;
	}
	const p = windows ? path.win32 : path.posix;
	const [a, b] = [p.normalize(fromUrl), p.normalize(file)];
	return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}
