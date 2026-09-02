const NAME_FIELD_PATTERN = /^(display\s?name|full\s?name|employee\s?name|person\s?name|checklist\s?name)$/i;
const FALLBACK_FIELD_PATTERN = /person.?number|id|code|title/i;

function pickDisplayLabel(item) {
  const keys = Object.keys(item).filter((k) => !k.startsWith('_') && typeof item[k] !== 'object' && item[k] !== null && item[k] !== '');

  // Pass 1: a genuinely name-shaped field, checked across every key first.
  const nameKey = keys.find((k) => NAME_FIELD_PATTERN.test(k.replace(/([a-z])([A-Z])/g, '$1 $2')));
  if (nameKey) return String(item[nameKey]);

  // Pass 2: First/Last name pair.
  const firstKey = keys.find((k) => /^first\s?name$/i.test(k.replace(/([a-z])([A-Z])/g, '$1 $2')));
  const lastKey = keys.find((k) => /^last\s?name$/i.test(k.replace(/([a-z])([A-Z])/g, '$1 $2')));
  if (firstKey || lastKey) {
    const combined = `${firstKey ? item[firstKey] : ''} ${lastKey ? item[lastKey] : ''}`.trim();
    if (combined) return combined;
  }

  // Pass 3 (last resort only): an ID/code/number/title field, since no real name field exists.
  const fallbackKey = keys.find((k) => FALLBACK_FIELD_PATTERN.test(k));
  if (fallbackKey) return String(item[fallbackKey]);

  return null;
}

module.exports = { pickDisplayLabel };
