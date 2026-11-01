import { spawn as spawnProcess, execFile } from 'node:child_process';
import { expansionCatalog } from './catalog.js';

const detectEspanso = () => new Promise((resolve, reject) => execFile('/usr/bin/pgrep', ['-x', 'espanso'], { timeout: 2000 }, (error) => {
 if (!error) resolve(true);
 else if (error.code === 1) resolve(false);
 else reject(new Error('Could not check whether another text expansion app is running.'));
}));

// Session-only opt-in. No helper is started by reads, tests, or app startup.
export function createExpansionControl({ service, executable, platform = process.platform, spawn = spawnProcess, espansoRunning = detectEspanso }) {
 let child = null, running = false, problem = '', disposed = false, timer = null, queue = Promise.resolve();
 let catalog = { entries: [], skipped: 0, conflicts: 0 };
 const serial = (fn) => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
 const snapshot = () => ({ supported: platform === 'darwin', enabled: !!child, running, problem, eligible: catalog.entries.length, skipped: catalog.skipped, conflicts: catalog.conflicts });
 async function stop() {
  clearInterval(timer); timer = null;
  const previous = child; child = null; running = false;
  if (previous) {
   await new Promise(resolve => {
    const timeout = setTimeout(() => { previous.kill('SIGKILL'); resolve(); }, 1000);
    previous.once('exit', () => { clearTimeout(timeout); resolve(); });
    previous.kill();
   });
  }
 }
 async function refresh() {
  catalog = expansionCatalog(await service.state());
  if (child) child.stdin.write(`${JSON.stringify(catalog.entries)}\n`);
 }
 return {
  status: () => serial(async () => { if (!child) await refresh(); return snapshot(); }),
  refresh: () => serial(async () => {
   try { await refresh(); } catch { await stop(); problem = 'Could not reload snippets. Expansion has stopped.'; }
  }),
  set: (input) => serial(async () => {
   if (typeof input?.enabled !== 'boolean') throw new Error('enabled must be true or false.');
   if (!input.enabled) { await stop(); problem = ''; return snapshot(); }
   if (!executable) throw new Error('Native expansion is unavailable in this test session.');
   if (disposed) throw new Error('The app is closing.');
   if (platform !== 'darwin') throw new Error('Built-in expansion currently requires macOS.');
   if (child) return snapshot();
   if (await espansoRunning()) throw new Error('Quit the other text expansion app before turning on built-in expansion.');
   await refresh();
   problem = ''; running = false;
   const process = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
   child = process;
   let output = '';
   process.stdout.on('data', chunk => {
    if (child !== process) return;
    output += chunk.toString();
    if (output.length > 16384) { process.kill(); return; }
    let end;
    while ((end = output.indexOf('\n')) >= 0) {
     const line = output.slice(0, end); output = output.slice(end + 1);
     try { const status = JSON.parse(line); running = status.running === true; problem = String(status.problem ?? ''); } catch { /* Only status JSON is accepted. */ }
    }
   });
   const failed = () => {
    if (child !== process) return;
    child = null; running = false; clearInterval(timer); timer = null;
    problem ||= 'Expansion stopped. Check Accessibility permission and the native helper build, then try again.';
   };
   process.on('error', failed); process.on('exit', failed);
   process.stdin.on('error', () => { process.kill(); failed(); });
   process.stdin.write(`${JSON.stringify(catalog.entries)}\n`);
   // Stop if the other expansion engine is started later, or detection fails.
   timer = setInterval(() => serial(async () => {
    if (!child) return;
    try { if (!(await espansoRunning())) return; } catch { /* Fail closed. */ }
    await stop(); problem = 'Expansion stopped because another text expansion app is running or its status could not be checked.';
   }), 2000);
   timer.unref?.();
   return snapshot();
  }),
  dispose: () => serial(async () => { disposed = true; await stop(); }),
 };
}
