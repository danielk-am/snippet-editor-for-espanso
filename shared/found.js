// A row in the assistant's "Closest matches": what it shows of a snippet's
// triggers, and where that snippet is now.
//
// A row says where a snippet was when the app looked. Files change, and a
// conversation is kept for days, so a row is found again when it is pressed:
// by its triggers, as the row shows them.

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '');

const MOST = 5;
const WIDE = 80;

// The triggers of a snippet, read as the assistant's tools read them.
export function triggersNow(match) {
	if (!isObject(match)) return [];
	if (Array.isArray(match.triggers)) return match.triggers.map(textOf).filter(Boolean);
	return [textOf(match.trigger) || textOf(match.regex)].filter(Boolean);
}

// As a row shows them: the first five, each cut to fit.
export const rowTriggers = (triggers) => triggers.slice(0, MOST).map((trigger) => (trigger.length > WIDE ? `${trigger.slice(0, WIDE - 1)}…` : trigger));

// The route that opens a row: the snippet where it is now, or its file when
// the snippet cannot be told apart any more, or nothing when the file is gone.
export function whereNow(files, hit) {
	if (!Array.isArray(files) || !isObject(hit) || typeof hit.fileId !== 'string') return null;
	const file = files.find((item) => isObject(item) && item.id === hit.fileId);
	if (!file) return null;
	const matches = Array.isArray(file.matches) ? file.matches : [];
	const wanted = Array.isArray(hit.triggers) && hit.triggers.length ? JSON.stringify(hit.triggers) : null;
	const same = (match) => wanted !== null && isObject(match) && JSON.stringify(rowTriggers(triggersNow(match))) === wanted;
	if (Number.isInteger(hit.index) && same(matches[hit.index])) return { view: 'snippet', fileId: file.id, index: hit.index };
	const moved = matches.findIndex(same);
	return moved === -1 ? { view: 'file', fileId: file.id } : { view: 'snippet', fileId: file.id, index: moved };
}
