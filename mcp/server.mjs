#!/usr/bin/env node
// The program an AI tool starts to work with Snippet Editor's snippets.
//
// It speaks the Model Context Protocol on its standard streams and holds no
// snippets of its own: every tool call goes to the app's local API, so the
// app must be open with "API for other tools" switched on.
//
//   node mcp/server.mjs
//
// The app's own chat starts it too, through Claude Code or Codex, with
// SNIPPET_EDITOR_CHAT naming the file that says where that message's
// listener is. Then nothing is written from here: a change is handed to the
// app, which shows it to the person as a card.
//
// Nothing but protocol messages is written to standard output.
import { createApiClient, createChatClient, dataDirFor } from './client.mjs';
import { createProtocol } from './protocol.mjs';
import { createTools } from './tools.mjs';

const START = 'Snippet Editor manages Espanso text-expansion snippets on this computer. Start with snippets_search or snippets_list_files. ';
const VERSION = 'Before changing a file, read it with snippets_get_file or snippets_get_snippet and pass its `version` to the tool that changes it. ';

const sessionFile = process.env.SNIPPET_EDITOR_CHAT;
const chat = sessionFile ? createChatClient({ sessionFile }) : null;

const protocol = createProtocol({
	serverInfo: { name: 'snippet-editor', title: 'Snippet Editor for Espanso', version: '0.1.0' },
	instructions: chat
		? `${START}${VERSION}You are in the app's own chat: a tool that changes something shows the person a card, and nothing is written until they press Apply.`
		: `${START}${VERSION}` +
			'The tools that change something work only when the person has switched on "Let AI tools change snippets" in the app\'s Settings. ' +
			'The app must be open, with "API for other tools" switched on.',
	tools: chat ? createTools({ api: chat, propose: chat.propose }) : createTools({ api: createApiClient({ dataDir: dataDirFor() }) }),
	log: (error) => process.stderr.write(`snippet-editor-mcp: ${error?.stack ?? error}\n`),
});

// A client that goes away mid-answer must not take the process down noisily.
process.stdout.on('error', () => process.exit(0));

await protocol.serve({ input: process.stdin, output: process.stdout });
// The client has gone. A call still waiting on the app must not keep this
// process alive: whatever it asked the app to do, the app finishes or refuses.
process.exit(0);
