const NAME_FIELD_PATTERN = /^(display\s?name|full\s?name|employee\s?name|person\s?name|checklist\s?name)$/i;

// Returns a genuinely human-readable name for a record, or null if none exists.
// Deliberately never falls back to an ID/code/number field (PersonId, PersonNumber,
// AssignmentId, etc.) — those are internal identifiers, not something a non-technical
// end user should ever see. Callers show a friendly generic label (e.g. "Team member")
// when this returns null.
function pickDisplayLabel(item) {
  const keys = Object.keys(item).filter((k) => !k.startsWith('_') && typeof item[k] !== 'object' && item[k] !== null && item[k] !== '');

  const nameKey = keys.find((k) => NAME_FIELD_PATTERN.test(k.replace(/([a-z])([A-Z])/g, '$1 $2')));
  if (nameKey) return String(item[nameKey]);

  const firstKey = keys.find((k) => /^first\s?name$/i.test(k.replace(/([a-z])([A-Z])/g, '$1 $2')));
  const lastKey = keys.find((k) => /^last\s?name$/i.test(k.replace(/([a-z])([A-Z])/g, '$1 $2')));
  if (firstKey || lastKey) {
    const combined = `${firstKey ? item[firstKey] : ''} ${lastKey ? item[lastKey] : ''}`.trim();
    if (combined) return combined;
  }

  return null;
}

module.exports = { pickDisplayLabel };
