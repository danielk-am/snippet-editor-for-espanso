import { createChatStore } from './chatStore.js';

// The chat's history, read once when the window opens. Storage that cannot
// be reached is treated as empty.
let storage = null;
try {
	storage = window.localStorage;
} catch {
	// No storage: the chat works, and forgets when the window closes.
}

const store = createChatStore(storage);
export const chatInitial = store.load();
export const saveChat = (state) => store.save(state);
