// Quitting waits for what the app started to be stopped.
//
// Electron does not wait for a promise in 'will-quit'. An answer under way
// would be left with its program running and its listener's file on disk. So
// the quit is held back, everything is stopped, and then the app quits for
// good. Stopping has a time limit, so the app always goes.
//
// In between, the app is still running with nothing behind it. A click on its
// Dock icon, or starting it again, would open a window whose every request
// fails. So no window may open then. The wish is kept instead, and the app
// comes back, started afresh, as soon as it has gone.
export function quitWhenDisposed({ app, dispose, deadline = 4000, log = console.error }) {
	let state = 'open';
	let wanted = false;
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
			// Before the quit: Electron starts it again once this one has gone.
			if (wanted) app.relaunch();
			// On a later turn, never from here. When nothing had to be waited
			// for, this still runs inside Electron's own telling of 'will-quit',
			// and a quit asked for there is dropped without a word. The app
			// would stay running with no window and everything behind it stopped.
			setImmediate(() => app.quit());
		});
	});
	return {
		// Asked before any window opens. False while the app is closing, and
		// asking is then what brings it back.
		mayOpen() {
			if (state === 'open') return true;
			const before = wanted;
			wanted = true;
			if (state === 'done') {
				// Already told to go for good, so there is no later moment to
				// wait for. It is told to come back, and told to go once more
				// in case the first telling was lost.
				if (!before) app.relaunch();
				app.quit();
			}
			return false;
		},
	};
}
