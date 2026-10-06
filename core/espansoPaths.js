import path from 'node:path';

// Where Espanso keeps its match files. Worked out from the same rules Espanso
// documents rather than by running `espanso path`, because that command
// creates the config folder as a side effect and this app should be able to
// look without touching anything.
export function resolveMatchDir({ override, env = {}, platform, homedir, exists = () => false }) {
	const p = platform === 'win32' ? path.win32 : path.posix;

	if (override) return { matchDir: override, source: 'settings' };
	if (env.SNIPPET_EDITOR_MATCH_DIR) return { matchDir: env.SNIPPET_EDITOR_MATCH_DIR, source: 'env' };
	if (env.ESPANSO_CONFIG_DIR) return { matchDir: p.join(env.ESPANSO_CONFIG_DIR, 'match'), source: 'env' };

	// On Linux ~/.config/espanso is the default, handled below.
	const legacy = [p.join(homedir, '.espanso')];
	if (platform === 'darwin') legacy.push(p.join(homedir, '.config', 'espanso'));
	for (const dir of legacy) {
		if (exists(dir)) return { matchDir: p.join(dir, 'match'), source: 'legacy' };
	}

	let configDir;
	if (platform === 'darwin') {
		configDir = p.join(homedir, 'Library', 'Application Support', 'espanso');
	} else if (platform === 'win32') {
		configDir = p.join(env.APPDATA || p.join(homedir, 'AppData', 'Roaming'), 'espanso');
	} else {
		configDir = p.join(env.XDG_CONFIG_HOME || p.join(homedir, '.config'), 'espanso');
	}
	return { matchDir: p.join(configDir, 'match'), source: 'default' };
}
