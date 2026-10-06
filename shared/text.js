// Values read from a YAML file can be any shape. These helpers turn them into
// something safe to show without ever calling a method the file could have
// replaced (a mapping with its own `toString` key, for example).

export function toText(value) {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
	return '';
}

export const isScalar = (value) => ['string', 'number', 'boolean'].includes(typeof value);

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Espanso ends a line at four characters that this app's YAML reader, like
// most, takes for ordinary text: a carriage return with no line feed after
// it, and U+0085, U+2028 and U+2029. (Checked against Espanso 2.4.1.) Text
// after one of them, on a comment line, is a comment here and live YAML to
// Espanso. So the app treats a file that holds one as a file with a problem,
// and never writes one. The code points are written as numbers, so this file
// holds none of them.
const BREAKS = String.fromCharCode(0x85, 0x2028, 0x2029);
const ODD_BREAK = new RegExp(`\\r(?!\\n)|[${BREAKS}]`);
const ODD_NAMES = { 0x0d: 'a lone carriage return', 0x85: 'U+0085', 0x2028: 'U+2028', 0x2029: 'U+2029' };

// The first such break in a text, with the line it is on, or null.
export function oddBreak(text) {
	const found = typeof text === 'string' ? ODD_BREAK.exec(text) : null;
	if (!found) return null;
	return { line: text.slice(0, found.index).split('\n').length, name: ODD_NAMES[found[0].charCodeAt(0)] };
}

export const oddBreakMessage = ({ line, name }) => `This text has a line break that Espanso reads and this app does not (${name}), at line ${line}. Remove it, or put a normal line break there.`;

// Every kind of line break, Espanso's four included.
export const ANY_BREAK = new RegExp(`\\r\\n|[\\n\\r${BREAKS}]`);
export const withoutBreaks = (text) => text.replace(new RegExp(`[\\n\\r${BREAKS}]+`, 'g'), ' ');
