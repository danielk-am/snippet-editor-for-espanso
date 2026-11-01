function dateVariables(match) {
 if (match.vars === undefined) return match.replace?.includes('{{') ? null : [];
 if (!Array.isArray(match.vars) || !match.vars.length) return null;
 const dates = [];
 for (const variable of match.vars) {
  if (!variable || Object.keys(variable).some(k => !['name', 'type', 'params'].includes(k)) || variable.type !== 'date' || typeof variable.name !== 'string' || !/^[a-zA-Z_]\w*$/.test(variable.name) || dates.some(d => d.name === variable.name)) return null;
  const params = variable.params;
  if (!params || Object.keys(params).some(k => k !== 'format') || typeof params.format !== 'string' || params.format.length > 256 || params.format.replace(/%[%YymdAaBbHIMSp]/gu, '').includes('%')) return null;
  dates.push({name: variable.name, format: params.format});
 }
 const stripped = dates.reduce((text, date) => text.replaceAll('{{' + date.name + '}}', ''), match.replace ?? '');
 return stripped.includes('{{') || stripped.includes('}}') ? null : dates;
}

// Only semantics the native engine implements. Unknown options fail closed.
export function expansionCatalog(state) {
 const candidates = [];
 const counts = new Map();
 let skipped = 0;
 const allowed = new Set(['trigger', 'triggers', 'replace', 'label', 'vars']);
 const files = [...(state.files ?? []), ...[...(state.packages ?? []), ...(state.team ?? [])].flatMap(p => p.files ?? [])];
 for (const file of files) {
  if (file.importOnly || file.parseErrors?.length) continue;
  for (const match of file.matches ?? []) {
   const triggers = match.triggers ?? [match.trigger];
   for (const trigger of [...(typeof match.trigger === 'string' ? [match.trigger] : []), ...(Array.isArray(match.triggers) ? match.triggers : [])]) {
    if (typeof trigger === 'string') counts.set(trigger, (counts.get(trigger) ?? 0) + 1);
   }
   const dates = typeof match.replace === 'string' ? dateVariables(match) : null;
   if (dates === null || Object.keys(match).some(key => !allowed.has(key)) || typeof match.replace !== 'string' || match.replace.includes('$|$') || match.replace.length > 100000 || !Array.isArray(triggers) || !triggers.length || triggers.some(t => typeof t !== 'string' || !/^[;:!#\/][^\s\x00-\x1f\x7f]{1,63}$/u.test(t))) { skipped++; continue; }
   for (const trigger of triggers) candidates.push({ trigger, replace: match.replace, ...(dates.length ? {dates} : {}) });
  }
 }

 return { entries: candidates.filter(e => counts.get(e.trigger) === 1), skipped, conflicts: [...counts.values()].filter(n => n > 1).length };
}
