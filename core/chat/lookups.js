import { foundItem } from '../../mcp/tools.mjs';
import { carried } from '../apiServer.js';
import { rowTriggers } from '../../shared/found.js';
import { keywordsOf } from '../../shared/search.js';

// What the app looks up before the assistant is asked, so that it need not
// ask: the snippets closest to the words of the message, the snippet that is
// open, and the file that is open. The two that read are made with a tool
// the assistant has, and are handed over in the shape that tool returns. The
// matches are shaped as the search tool shapes a match, with long triggers,
// labels and names cut short. They are also what the panel shows at once.
//
// Looking up is a convenience. Whatever cannot be looked up is left out, and
// the assistant asks for it as it always could.

const MATCHES = 8;
// Asked of the store, so that eight are left when some cannot be handed over.
const ASKED = 24;
const FILE_SNIPPETS = 25;
// The most all of it may come to, as JSON.
const MOST = 12_000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cut = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);
const size = (parts) => JSON.stringify(parts).length;

// A match as it is handed over: what the search tool would say of it, kept
// short. One snippet with an enormous label must not cost the others their place.
function matchItem(hit) {
	const item = foundItem(hit);
	return { ...item, file: cut(item.file, 80), ...(item.package ? { package: cut(item.package, 80) } : {}), triggers: rowTriggers(item.triggers), label: cut(item.label, 80) };
}

// The same match, for the panel: enough to show a row and to open the snippet.
const shown = ({ file_id: fileId, file: fileName, ...rest }) => ({ fileId, fileName, ...rest });

export function createLookups({ store, tools, log = console.error, most = MOST }) {
	// One of the assistant's own read tools, called for it. A refusal, or a
	// file that can only report its problem, is nothing worth handing over.
	async function asked(tool, args) {
		try {
			const reply = await tools.call(tool, args);
			if (!reply || reply.isError || typeof reply.structuredContent?.problem === 'string') return null;
			return { tool, args, result: reply.structuredContent };
		} catch (error) {
			log(error);
			return null;
		}
	}

	async function searched(text) {
		const words = keywordsOf(text).map((item) => item.word);
		if (!words.length) return null;
		try {
			// As the tools would get them: a snippet JSON cannot carry is left out.
			const reply = carried(200, await store.likely(text, { limit: ASKED }));
			const hits = reply.status === 200 ? JSON.parse(reply.text).slice(0, MATCHES) : [];
			return hits.length ? { tool: 'snippets_search', words, result: { items: hits.map(matchItem) } } : null;
		} catch (error) {
			log(error);
			return null;
		}
	}

	return async function lookUp({ text, context } = {}) {
		// What the window says is open is only ever passed to the read tools.
		const fileId = isObject(context) && typeof context.fileId === 'string' && context.fileId ? context.fileId : null;
		const index = fileId && Number.isInteger(context.index) && context.index >= 0 ? context.index : null;

		let [snippet, search, file] = await Promise.all([
			index === null ? null : asked('snippets_get_snippet', { file_id: fileId, index }),
			searched(text),
			fileId === null ? null : asked('snippets_get_file', { file_id: fileId, limit: FILE_SNIPPETS }),
		]);

		// Kept under the cap. A snippet too long to hand over is left for the
		// assistant to read. Then the file's summary gives way, then matches
		// from the far end.
		const parts = () => [snippet, search, file].filter(Boolean);
		if (snippet && size([snippet]) > most) snippet = null;
		if (size(parts()) > most) file = null;
		while (search && size(parts()) > most) {
			search.result.items.pop();
			if (!search.result.items.length) search = null;
		}

		return { found: search ? search.result.items.map(shown) : [], lookups: parts() };
	};
}
