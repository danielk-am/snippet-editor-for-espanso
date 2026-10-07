// The name of a model, where one is handed to a program as an argument.
//
// It is plain or it is not used: a letter or digit first, then letters,
// digits, dots, dashes, underscores and colons, 80 characters at most. So it
// cannot be read as an option, and needs no quoting anywhere.
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

// The arguments that pick a model, or none when the tool is left to choose.
export function modelArgs(flag, model) {
	if (model === undefined || model === null || model === '') return [];
	if (typeof model !== 'string' || !MODEL_NAME.test(model)) throw new TypeError('That is not the name of a model.');
	return [flag, model];
}
