// Copy the imagegen logo master to the packaging asset. The earlier flat
// icon remains in build/icon.png for reference.
import fs from 'node:fs';
const source = new URL('../renderer/assets/snippet-editor-glass.png', import.meta.url);
const output = new URL('../build/icon-glass.png', import.meta.url);
fs.copyFileSync(source, output);
console.log('Copied glass logo to build/icon-glass.png');
