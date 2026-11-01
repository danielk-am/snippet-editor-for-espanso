import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createExpansionControl } from '../core/expansion/control.js';
function setup(extra={}) {
 const children=[];
 const control=createExpansionControl({ platform:'darwin', executable:'/helper', service:{state:async()=>({files:[{matches:[{trigger:';hi',replace:'Hello'}]}]})}, espansoRunning:async()=>false, spawn:()=>{
  const child=new EventEmitter(); child.stdout=new EventEmitter(); child.stdin=new EventEmitter(); child.stdin.write=()=>{}; child.kill=()=>{child.killed=true; queueMicrotask(()=>child.emit('exit',0));}; children.push(child); return child;
 }, ...extra });
 return { control, children };
}
test('off by default, turns off and kills helper', async()=>{
 const {control,children}=setup(); assert.equal((await control.status()).enabled,false);
 await control.set({enabled:true}); assert.equal(children.length,1);
 children[0].stdout.emit('data',Buffer.from('{"running":true}\n'));
 assert.equal((await control.status()).running,true);
 await control.set({enabled:false}); assert.equal(children[0].killed,true);
 assert.equal((await control.status()).running,false); await control.dispose();
});
test('unsupported platforms and Espanso do not start a helper',async()=>{
 for(const extra of [{platform:'win32'},{espansoRunning:async()=>true}]) {
  const {control,children}=setup(extra); await assert.rejects(control.set({enabled:true})); assert.equal(children.length,0); await control.dispose();
 }
});
test('a crashed helper is reported and cannot leave running status',async()=>{
 const {control,children}=setup(); await control.set({enabled:true}); children[0].emit('exit',1);
 const status=await control.status(); assert.equal(status.running,false); assert.equal(status.enabled,false); assert.ok(status.problem); await control.dispose();
});
test('concurrent enables start only one helper and disposal prevents restart',async()=>{
 const {control,children}=setup(); await Promise.all([control.set({enabled:true}),control.set({enabled:true})]); assert.equal(children.length,1);
 await control.dispose(); await assert.rejects(control.set({enabled:true}));
});
