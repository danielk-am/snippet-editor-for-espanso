import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expansionCatalog } from '../core/expansion/catalog.js';
const state = (matches, extra = {}) => ({ files: [{ name: 'base.yml', matches, ...extra }], packages: [], team: [] });
test('plain triggers and multiple triggers are eligible without Espanso', () => {
 const c = expansionCatalog(state([{ trigger: ';hi', replace: 'Hello' }, { triggers: [';a',';b'], replace: 'Two\nlines' }]));
 assert.deepEqual(c.entries.map(x => x.trigger), [';hi',';a',';b']);
 assert.equal(c.skipped, 0);
});
test('unsupported semantics are excluded rather than expanded incorrectly', () => {
 const c = expansionCatalog(state([{ regex: 'x', replace: 'y' }, {trigger:';x',replace:'{{date}}'}, {trigger:';f',form:'x'}, {trigger:';w',replace:'x',word:true}, {trigger:';v',replace:'x',vars:[]}, {trigger:';c',replace:'x',propagate_case:true}, {trigger:';u',replace:'x',left_word:true}]));
 assert.equal(c.entries.length,0); assert.equal(c.skipped,7);
});
test('ambiguous duplicate triggers are all removed', () => {
 const c=expansionCatalog(state([{trigger:';x',replace:'a'},{trigger:';x',replace:'b'}]));
 assert.equal(c.entries.length,0); assert.equal(c.conflicts,1);
});
test('import-only and invalid files do not become active', () => {
 assert.equal(expansionCatalog(state([{trigger:';x',replace:'y'}],{importOnly:true})).entries.length,0);
});
test('bounds exclude empty, plain word and control-character triggers', () => {
 const c=expansionCatalog(state(['','word',';x\n',';'+'x'.repeat(65)].map(trigger=>({trigger,replace:'x'}))));
 assert.equal(c.entries.length,0);
});
test('unsupported duplicates still make a trigger ambiguous', () => {
 const c = expansionCatalog(state([{trigger:';x',replace:'plain'},{trigger:';x',replace:'conditional',word:true}]));
 assert.equal(c.entries.length,0); assert.equal(c.conflicts,1);
});
test('date variables are passed to the native engine for evaluation when typed', () => {
 const c=expansionCatalog(state([{trigger:':today',replace:'{{today}}',vars:[{name:'today',type:'date',params:{format:'%A, %d %b %Y'}}]}]));
 assert.equal(c.entries.length,1);
 assert.deepEqual(c.entries[0].dates,[{name:'today',format:'%A, %d %b %Y'}]);
});
test('unknown date formats, extra options and unresolved placeholders remain excluded', () => {
 for (const vars of [[{name:'today',type:'date',params:{format:'%Q'}}], [{name:'today',type:'date',params:{format:'%Y',offset:1}}], [{name:'today',type:'shell',params:{cmd:'date'}}]]) {
  assert.equal(expansionCatalog(state([{trigger:':today',replace:'{{today}}',vars}])).entries.length,0);
 }
 assert.equal(expansionCatalog(state([{trigger:':today',replace:'{{other}}',vars:[{name:'today',type:'date',params:{format:'%Y'}}]}])).entries.length,0);
});
test('date names must be strings and literal percent formats stay valid', () => {
 for (const name of [undefined, true, 123]) {
  const c=expansionCatalog(state([{trigger:':x',replace:'plain',vars:[{name,type:'date',params:{format:'%Y'}}]}]));
  assert.equal(c.entries.length,0);
 }
 const c=expansionCatalog(state([{trigger:':x',replace:'{{x}}',vars:[{name:'x',type:'date',params:{format:'%% %Y'}}]}]));
 assert.equal(c.entries.length,1);
});
