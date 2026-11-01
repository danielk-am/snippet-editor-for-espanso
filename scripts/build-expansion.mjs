import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
if (process.platform !== 'darwin') process.exit(0);
mkdirSync('build/native', { recursive: true });
for (const arch of ['arm64', 'x86_64']) execFileSync('/usr/bin/swiftc', ['-O', '-target', `${arch}-apple-macosx12.0`, 'native/macos/SnippetExpansion.swift', '-o', `build/native/expansion-${arch}`], { stdio: 'inherit' });
execFileSync('/usr/bin/lipo', ['-create', 'build/native/expansion-arm64', 'build/native/expansion-x86_64', '-output', 'build/native/snippet-expansion']);
// Keep the helper identity stable across compiler-generated UUID changes.
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'am.danielk.snippet-editor.expansion', 'build/native/snippet-expansion']);
execFileSync('build/native/snippet-expansion', ['--self-test'], { stdio: 'inherit' });
