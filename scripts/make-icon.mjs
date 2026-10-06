// Draws the app icon and saves it as build/icon.png (1024 x 1024).
// Run with `npm run icon`. electron-builder turns that one PNG into the
// .icns, .ico and Linux icons when it packages the app.
//
// The mark is the one in the sidebar: a prompt on the brand blue. To use a
// different icon, replace build/icon.png and skip this script.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const SIZE = 1024;
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');

// Brand blue to its hover shade, from renderer/styles/tokens.css. The square
// is inset the way macOS icons are, so it sits right in the Dock.
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024">
	<defs>
		<linearGradient id="blue" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#2563EB" />
			<stop offset="1" stop-color="#1D4ED8" />
		</linearGradient>
	</defs>
	<rect x="100" y="100" width="824" height="824" rx="184" fill="url(#blue)" />
	<g transform="translate(56 56) scale(38)" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<path d="m7 8 4 4-4 4" />
		<path d="M13 16h4" />
	</g>
</svg>`;

app.whenReady().then(async () => {
	const win = new BrowserWindow({
		width: SIZE,
		height: SIZE,
		show: false,
		frame: false,
		transparent: true,
		webPreferences: { offscreen: true },
	});
	const page = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
	await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
	await new Promise((resolve) => setTimeout(resolve, 300));
	const image = await win.webContents.capturePage();
	const { width, height } = image.getSize();
	if (width !== SIZE || height !== SIZE) {
		console.error(`Expected ${SIZE} x ${SIZE}, got ${width} x ${height}`);
		app.exit(1);
		return;
	}
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, image.toPNG());
	console.log(`Wrote ${out}`);
	app.exit(0);
});
