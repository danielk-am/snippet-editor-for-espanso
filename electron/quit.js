// Quitting waits for what the app started to be stopped.
//
// Electron does not wait for a promise in 'will-quit'. An answer under way
// would be left with its program running and its listener's file on disk. So
// the quit is held back, everything is stopped, and then the app quits for
// good. Stopping has a time limit, so the app always goes.
export function quitWhenDisposed({ app, dispose, deadline = 4000, log = console.error }) {
	let state = 'open';
	app.on('will-quit', (event) => {
		if (state === 'done') return;
		event.preventDefault();
		if (state === 'closing') return;
		state = 'closing';
		// Started at once, not on a later turn: some of it cannot wait.
		let stopped;
		try {
			stopped = Promise.resolve(dispose()).catch(log);
		} catch (error) {
			log(error);
			stopped = Promise.resolve();
		}
		const late = new Promise((resolve) => setTimeout(resolve, deadline));
		Promise.race([stopped, late]).then(() => {
			state = 'done';
			app.quit();
		});
	});
}
