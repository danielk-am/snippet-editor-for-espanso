import { createContext, useContext, useLayoutEffect, useRef } from '../vendor/preact-htm.js';
import { createDraftStorage } from './draftStorage.js';

export const DraftContext = createContext(null);
export const RawDraftContext = createContext(null);
export const draftStorage = () => createDraftStorage(localStorage);

export function useDraft(kind) {
	const context = useContext(DraftContext);
	const initial = useRef(context?.recovered?.kind === kind ? context.recovered.value : null);
	return {
		initial: initial.current,
		kind,
		context,
	};
}

export function useKeepDraft(recovery, value, dirty) {
	const { context, kind } = recovery;
	useLayoutEffect(() => {
		if (!context) return;
		try {
			if (dirty) draftStorage().write(context.scope, { route: context.route, kind, value });
			else draftStorage().clear(context.scope);
			context.notice('');
		} catch {
			context.notice('The recovery draft could not be stored. Keep this window open until you save or copy your edits.');
		}
	});
}
