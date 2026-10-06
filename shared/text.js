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
