// Runs the app's API for the usability check: the fixtures, a long file that
// forces paging, and a team repository with one package installed. Nothing
// here touches the real Espanso folder, the network or GitHub.
//
//   node test/mcp-eval/serve.mjs      (leave it running; Ctrl+C to stop)
//
// It writes the data folder it uses to test/mcp-eval/.session, where
// ask.mjs finds it.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createListenerControl } from '../../core/apiListener.js';
import { createRouter } from '../../core/apiRouter.js';
import { createGit } from '../../core/git.js';
import { createService } from '../../core/service.js';
import { MANIFEST, gitEnv, seeded } from '../helpers/teamRemote.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'snippet-editor-eval-'));
const matchDir = join(root, 'match');
cpSync(join(here, '..', 'fixtures', 'match'), matchDir, { recursive: true });

// 400 snippets, so that no single reply can hold the file. One of them, at
// position 317, expands to a much longer text than the rest.
const long = 'This is the one long reply in the catalog, written out at length so that it stands apart from every other entry here.';
const catalog = Array.from({ length: 400 }, (_, index) => {
	const number = String(index).padStart(3, '0');
	return `  - trigger: ":item${number}"\n    label: "Item ${number}"\n    replace: "${index === 317 ? long : `Reply ${number}`}"\n`;
}).join('');
writeFileSync(join(matchDir, 'catalog.yml'), `# A long list, for paging\n\nmatches:\n${catalog}`);

const remote = seeded(join(root, 'remote'));
remote.commit({
	'packages/tools/_manifest.yml': MANIFEST('tools'),
	'packages/tools/package.yml': 'matches:\n  - trigger: ":ip"\n    replace: "{{ip}}"\n    vars:\n      - name: ip\n        type: shell\n        params:\n          cmd: "ipconfig getifaddr en0"\n',
});

const port = await new Promise((resolve) => {
	const probe = net.createServer();
	probe.listen(0, '127.0.0.1', () => {
		const found = probe.address().port;
		probe.close(() => resolve(found));
	});
});
const dataDir = join(root, 'data');
const service = await createService({ userDataDir: dataDir, env: { SNIPPET_EDITOR_MATCH_DIR: matchDir }, git: createGit({ allowLocal: true, env: gitEnv(remote.root) }), allowLocalRepositories: true });
await service.connectTeam(remote.url);
await service.team().install('support');
const listener = createListenerControl({ service, router: createRouter({ service }) });
await listener.set({ enabled: true, port });

writeFileSync(join(here, '.session'), dataDir);
console.log(`The API for the usability check is running on port ${port}. Data folder: ${dataDir}`);

const stop = async () => {
	await listener.stop();
	service.dispose();
	rmSync(root, { recursive: true, force: true });
	rmSync(join(here, '.session'), { force: true });
	process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
