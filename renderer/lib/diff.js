// What changed between two texts, line by line, for a proposal's card: the
// lines that go, the lines that come, and a little of what is around them.
// Long stretches that did not change are folded into a count.
//
// Rows: { kind: 'same' | 'add' | 'remove', text }, { kind: 'skip', count },
// and { kind: 'note', text } when no line differs but the texts do.

const linesOf = (text) => {
	if (text === null || text === undefined || text === '') return [];
	const lines = String(text).split('\n');
	if (lines.at(-1) === '') lines.pop();
	return lines;
};

// The middles that differ, compared by their longest common run of lines.
function compare(a, b, budget) {
	// Too much to compare closely: all of the old, then all of the new.
	if (a.length * b.length > budget) return [...a.map((text) => ({ kind: 'remove', text })), ...b.map((text) => ({ kind: 'add', text }))];
	const width = b.length + 1;
	// common[i * width + j]: how many lines a[i..] and b[j..] share, in order.
	const common = new Uint16Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i -= 1) {
		for (let j = b.length - 1; j >= 0; j -= 1) {
			common[i * width + j] = a[i] === b[j] ? common[(i + 1) * width + j + 1] + 1 : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
		}
	}
	const rows = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			rows.push({ kind: 'same', text: a[i] });
			i += 1;
			j += 1;
		} else if (common[(i + 1) * width + j] >= common[i * width + j + 1]) {
			rows.push({ kind: 'remove', text: a[i] });
			i += 1;
		} else {
			rows.push({ kind: 'add', text: b[j] });
			j += 1;
		}
	}
	for (; i < a.length; i += 1) rows.push({ kind: 'remove', text: a[i] });
	for (; j < b.length; j += 1) rows.push({ kind: 'add', text: b[j] });
	return rows;
}

export function diffLines(before, after, { context = 2, budget = 2_000_000 } = {}) {
	const a = linesOf(before);
	const b = linesOf(after);

	// What the two share at the top and at the bottom needs no comparing.
	let top = 0;
	while (top < a.length && top < b.length && a[top] === b[top]) top += 1;
	let endA = a.length;
	let endB = b.length;
	while (endA > top && endB > top && a[endA - 1] === b[endB - 1]) {
		endA -= 1;
		endB -= 1;
	}
	if (top === endA && top === endB) {
		return (before ?? '') === (after ?? '') ? [] : [{ kind: 'note', text: 'Only the line end at the bottom differs.' }];
	}

	const same = (text) => ({ kind: 'same', text });
	const rows = [...a.slice(0, top).map(same), ...compare(a.slice(top, endA), b.slice(top, endB), budget), ...a.slice(endA).map(same)];

	// Keep the unchanged lines near a change, and fold the rest.
	const near = new Uint8Array(rows.length);
	rows.forEach((row, index) => {
		if (row.kind === 'same') return;
		for (let at = Math.max(0, index - context); at <= Math.min(rows.length - 1, index + context); at += 1) near[at] = 1;
	});
	const folded = [];
	let hidden = 0;
	rows.forEach((row, index) => {
		if (near[index]) {
			if (hidden) folded.push({ kind: 'skip', count: hidden });
			hidden = 0;
			folded.push(row);
		} else hidden += 1;
	});
	if (hidden) folded.push({ kind: 'skip', count: hidden });
	return folded;
}
