// Substring search over the fields a person would remember a snippet by.
// A scan, not an index: a personal match folder holds hundreds of snippets,
// not millions.

import { toText } from './text.js';

const TRIGGER_FIELDS = ['trigger', 'triggers', 'regex'];
const OTHER_FIELDS = ['label', 'search_terms', 'replace', 'markdown', 'html', 'form', 'image_path'];

function fieldText(match, fields) {
	return fields
		.flatMap((field) => {
			const value = match[field];
			if (value === undefined || value === null) return [];
			return Array.isArray(value) ? value.map(toText) : [toText(value)];
		})
		.join('\n')
		.toLowerCase();
}

export function searchFiles(files, query, { limit = 200 } = {}) {
	const terms = String(query ?? '')
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	if (!terms.length) return [];

	const hits = [];
	for (const file of files) {
		if (!Array.isArray(file.matches)) continue;
		file.matches.forEach((match, index) => {
			const triggers = fieldText(match, TRIGGER_FIELDS);
			const rest = fieldText(match, OTHER_FIELDS);
			if (!terms.every((term) => triggers.includes(term) || rest.includes(term))) return;
			hits.push({
				fileId: file.id,
				fileName: file.name,
				source: file.source,
				package: file.package,
				index,
				match,
				inTrigger: terms.some((term) => triggers.includes(term)),
			});
		});
	}

	// Stable sort: trigger hits first, file and list order otherwise.
	hits.sort((a, b) => Number(b.inTrigger) - Number(a.inTrigger));
	return hits.slice(0, limit);
}
