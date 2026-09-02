// Detects an explicit Oracle PersonNumber (e.g. "NM1658") or a pure numeric person ID
// mentioned in a user's message, regardless of whether the word "number" appears —
// "person NM1658", "person number NM1658", and a bare "NM1658" should all resolve
// the same way. Must run against the ORIGINAL (non-lowercased) message text, since
// alphanumeric codes like "NM1658" carry meaningful uppercase letters that a
// lowercased copy of the message would destroy.
function detectPersonNumber(message) {
  const explicit = message.match(/person\s*(?:number|#|no\.?)?\s*[:#]?\s*([A-Za-z]{1,4}\d{2,}|\d{4,})\b/i);
  if (explicit) return explicit[1].toUpperCase();

  const standaloneCode = message.match(/\b([A-Za-z]{1,4}\d{2,})\b/);
  if (standaloneCode) return standaloneCode[1].toUpperCase();

  const standaloneDigits = message.match(/\b(\d{4,})\b/);
  if (standaloneDigits) return standaloneDigits[1].toUpperCase();

  return null;
}

// Detects whether a message is genuinely a self-reference ("my absences", "mine",
// "myself", "absences for me") versus just containing the word "me" as the object of
// a request verb ("show me...", "tell me...", "give me...", "get me...", "find me...")
// which is not a self-reference at all - it's ordinary imperative phrasing that could
// be about anyone or anything.
function detectSelfReference(message) {
  if (/\bmy\b|\bmine\b|\bmyself\b/i.test(message)) return true;
  const withoutRequestVerbMe = message.replace(/\b(show|tell|give|get|find|fetch|pull up)\s+me\b/gi, '$1');
  return /\bme\b/i.test(withoutRequestVerbMe);
}

module.exports = { detectPersonNumber, detectSelfReference };
