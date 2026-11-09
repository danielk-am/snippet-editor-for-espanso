// Record the real Electron UI against disposable sample snippets.
// Run: FFMPEG=/path/to/ffmpeg node_modules/.bin/electron scripts/capture-readme.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { app, ipcMain } from 'electron';
import { startBackend } from '../electron/bootstrap.js';
import { createMainWindow, isTrustedSender } from '../electron/window.js';
import { mcpSetup } from '../electron/mcpSetup.js';
assert.ok(process.env.FFMPEG, 'Set FFMPEG to the encoder executable.');
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/media');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'snippet-readme-'));
const frames = path.join(sandbox, 'frames');
const matchDir = path.join(sandbox, 'match');
fs.mkdirSync(frames); fs.mkdirSync(matchDir); fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(matchDir, 'base.yml'), '# Everyday replies\nmatches:\n  - trigger: ";hello"\n    replace: "Hello there"\n  - trigger: ";thanks"\n    replace: "Thank you for your help!"\n  - trigger: ";followup"\n    replace: "Just checking in. Is there anything else you need from me?"\n');
fs.writeFileSync(path.join(matchDir, 'work.yml'), 'matches:\n  - trigger: ";meeting"\n    replace: "Thanks for meeting today. I will send the notes shortly."\n');
app.setPath('userData', path.join(sandbox, 'data'));
let win, backend, recording = false, recorder;
const timeline = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => app.exit(1), 90000);
app.whenReady().then(async () => {
 try {
  backend = await startBackend({ ipcMain, userDataDir: app.getPath('userData'), env: { SNIPPET_EDITOR_MATCH_DIR: matchDir },
   onChange: () => win?.webContents.send('data:changed'), getWindow: () => win, isTrustedSender,
   mcp: mcpSetup({ packaged: false, execPath: process.execPath, resourcesPath: process.resourcesPath, appPath: root }) });
  win = createMainWindow({ show: false, width: 1440, height: 900, webPreferences: { offscreen: true } });
  await once(win.webContents, 'did-finish-load');
  const js = code => win.webContents.executeJavaScript(code, true);
  const wait = async expression => { for(let i=0;i<150;i++){if(await js(`Boolean(${expression})`))return;await sleep(50);}throw Error(expression); };
  const click = async (text, selector='button') => js(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)}).click()`);
  const type = async (selector,value) => js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus(); const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const shot = async name => { await sleep(250); fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG()); };
  await wait(`document.querySelector('.sidebar')`);
  await click('All snippets','.nav-item__label');
  await wait(`document.querySelectorAll('.snippet-row').length===4`);
  await sleep(1500);
  await shot('snippets');
  recording = true;
  const epoch = performance.now();
  recorder = (async()=>{let n=0;while(recording){const start=performance.now();const file=String(n++).padStart(5,'0')+'.png';const capture=await win.webContents.capturePage();fs.writeFileSync(path.join(frames,file),capture.toPNG());timeline.push({file,time:(performance.now()-epoch)/1000});await sleep(Math.max(0,100-(performance.now()-start)));}})();
  await sleep(2000);
  for(const partial of ['t','th','tha','than','thank']){await type('input[type=search]',partial);await sleep(180);}
  await wait(`document.querySelectorAll('.snippet-row').length===2`);
  await shot('search'); await sleep(2000);
  await type('input[type=search]','');
  await click('base.yml','.nav-item__label');
  await wait(`document.querySelector('.snippet-row__open')`);
  await js(`document.querySelector('.snippet-row__open').click()`);
  await wait(`document.querySelector('.editor textarea')?.value==='Hello there'`);
  await shot('editor'); await sleep(2000);
  const replacement='Hello! How can I help you today?';
  await type('.editor textarea','');
  for(let i=1;i<=replacement.length;i++){await type('.editor textarea',replacement.slice(0,i));await sleep(65);}
  await sleep(1500); await click('Save');
  await wait(`[...document.querySelectorAll('.action-bar__status')].some(el=>el.textContent.trim()==='Saved')`);
  assert.ok(fs.readFileSync(path.join(matchDir,'base.yml'),'utf8').includes(replacement));
  await sleep(2500);
  recording=false; await recorder;
  // Concat timestamps preserve actual elapsed time between screen captures.
  const concat=timeline.map((f,i)=>`file '${f.file}'\nduration ${i+1<timeline.length?timeline[i+1].time-f.time:0.1}`).join('\n')+`\nfile '${timeline.at(-1).file}'\n`;
  fs.writeFileSync(path.join(frames,'frames.txt'),concat);
  const encoder=spawn(process.env.FFMPEG,['-y','-loglevel','error','-f','concat','-safe','0','-i',path.join(frames,'frames.txt'),'-vf','fps=10','-c:v','libx264','-crf','23','-pix_fmt','yuv420p','-movflags','+faststart',path.join(output,'walkthrough.mp4')],{stdio:'inherit'});
  const [code]=await once(encoder,'exit'); assert.equal(code,0);
  fs.writeFileSync(path.join(output,'capture.json'),JSON.stringify({appVersion:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,viewport:{width:1440,height:900},sampleData:true,realUI:true,assistantSimulated:false,actions:['Search thank across two files','Open ;hello','Edit replacement text','Save and verify file on disk'],captureDurationSeconds:timeline.at(-1).time,frames:timeline.length,frameRate:10,audio:false,cursor:false},null,2)+'\n');
  console.log(`PASS: screenshots and ${timeline.at(-1).time.toFixed(1)}s recording; saved replacement verified on disk.`);
 }catch(error){console.error(error);process.exitCode=1;}
 finally{recording=false;await recorder;await backend?.dispose();win?.destroy();clearTimeout(watchdog);fs.rmSync(sandbox,{recursive:true,force:true});app.exit(process.exitCode??0);}
});
