#!/usr/bin/env node
// The program an AI tool starts to work with Snippet Editor's snippets.
//
// It speaks the Model Context Protocol on its standard streams and holds no
// snippets of its own: every tool call goes to the app's local API, so the
// app must be open with "API for other tools" switched on.
//
//   node mcp/server.mjs
//
// Nothing but protocol messages is written to standard output.
import { createApiClient, dataDirFor } from './client.mjs';
import { createProtocol } from './protocol.mjs';
import { createTools } from './tools.mjs';

const protocol = createProtocol({
	serverInfo: { name: 'snippet-editor', title: 'Snippet Editor for Espanso', version: '0.1.0' },
	instructions:
		'Snippet Editor manages Espanso text-expansion snippets on this computer. Start with snippets_search or snippets_list_files. ' +
		'Before changing a file, read it with snippets_get_file or snippets_get_snippet and pass its `version` to the tool that changes it. ' +
		'The tools that change something work only when the person has switched on "Let AI tools change snippets" in the app\'s Settings. ' +
		'The app must be open, with "API for other tools" switched on.',
	tools: createTools({ api: createApiClient({ dataDir: dataDirFor() }) }),
	log: (error) => process.stderr.write(`snippet-editor-mcp: ${error?.stack ?? error}\n`),
});

// A client that goes away mid-answer must not take the process down noisily.
process.stdout.on('error', () => process.exit(0));

await protocol.serve({ input: process.stdin, output: process.stdout });
// The client has gone. A call still waiting on the app must not keep this
// process alive: whatever it asked the app to do, the app finishes or refuses.
process.exit(0);
