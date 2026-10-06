// Asks the real Espanso program to read files this app wrote. Run with
// `npm run test:espanso` on a computer that has Espanso installed.
//
// Everything happens in a temporary folder that Espanso is pointed at through
// its own environment variables, so your real Espanso setup is not touched.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMatchUpdate, insertMatch } from '../core/matchFile.js';

let version;
try {
	version = execFileSync('espanso', ['--version'], { encoding: 'utf8' }).trim();
} catch {
	console.log('Espanso is not installed here, so this check was skipped.');
	process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snippet-editor-espanso-'));
for (const dir of ['config', 'match', 'packages', 'runtime']) fs.mkdirSync(path.join(root, dir));
fs.writeFileSync(path.join(root, 'config', 'default.yml'), '# empty\n');

// Text a person might write without quotes. The editor shows it as these
// characters because that is how Espanso reads it; this proves the second half.
fs.writeFileSync(
	path.join(root, 'match', 'numbers.yml'),
	'matches:\n  - trigger: ":zip"\n    replace: 02134\n  - trigger: ":phone"\n    replace: +6591234567\n  - trigger: ":yes"\n    replace: true\n'
);

// A file changed the way the editor changes one.
let edited = 'matches:\n  # Greeting\n  - trigger: ":hello"\n    replace: "Hello there"\n';
edited = applyMatchUpdate(edited, 0, { trigger: ':hello', replace: 'Hello from the app' });
edited = insertMatch(edited, { trigger: ':spaces', replace: '  kept  ' });
edited = insertMatch(edited, { triggers: [':t1', ':t2'], replace: 'tab\there "quoted" #hash' });
edited = insertMatch(edited, { trigger: ':lines', replace: 'Line one\nLine two' });
fs.writeFileSync(path.join(root, 'match', 'edited.yml'), edited);

const listed = JSON.parse(
	execFileSync('espanso', ['match', 'list', '--json'], {
		encoding: 'utf8',
		env: { ...process.env, ESPANSO_CONFIG_DIR: root, ESPANSO_PACKAGE_DIR: path.join(root, 'packages'), ESPANSO_RUNTIME_DIR: path.join(root, 'runtime') },
	})
);
fs.rmSync(root, { recursive: true, force: true });

// What Espanso should report, written out by hand.
const expected = [
	{ triggers: [':zip'], replace: '02134' },
	{ triggers: [':phone'], replace: '+6591234567' },
	{ triggers: [':yes'], replace: 'true' },
	{ triggers: [':hello'], replace: 'Hello from the app' },
	{ triggers: [':spaces'], replace: '  kept  ' },
	{ triggers: [':t1', ':t2'], replace: 'tab\there "quoted" #hash' },
	{ triggers: [':lines'], replace: 'Line one\nLine two' },
];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const missing = expected.filter((want) => !listed.some((got) => same(got.triggers, want.triggers) && got.replace === want.replace));
if (missing.length) {
	console.log(`Espanso ${version} did not read these as written:\n${JSON.stringify(missing, null, 1)}\n--- it read ---\n${JSON.stringify(listed, null, 1)}`);
	process.exit(1);
}
console.log(`Espanso ${version} read every snippet as written (${expected.length} checked).`);
