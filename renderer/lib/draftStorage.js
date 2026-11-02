// Drafts stay in this Electron profile, outside Espanso's watched folders.
// Let callers surface quota/access errors instead of claiming a draft was kept.
export function createDraftStorage(storage) {
	const key = (scope) => `snippet-editor:draft:v1:${scope}`;
	return {
		read(scope) {
			const text = storage.getItem(key(scope));
			if (!text) return null;
			const record = JSON.parse(text);
			if (!['snippet', 'raw'].includes(record?.kind) || !record.route || typeof record.route.fileId !== 'string' || !record.value || typeof record.value !== 'object') throw new Error('The saved draft could not be read.');
			return record;
		},
		write(scope, record) { storage.setItem(key(scope), JSON.stringify(record)); },
		clear(scope) { storage.removeItem(key(scope)); },
	};
}
