import { describe, it, expect } from 'vitest';
import { detectPersonNumber, detectSelfReference } from '../../src/renderer/person-query-parser.js';

describe('detectPersonNumber', () => {
  it('detects an alphanumeric person number when the word "number" is present', () => {
    expect(detectPersonNumber('What is the department of person number NM1658')).toBe('NM1658');
  });

  it('detects an alphanumeric person number when "number" is omitted (the reported bug)', () => {
    expect(detectPersonNumber('Show me details for person NM1658')).toBe('NM1658');
  });

  it('detects a bare alphanumeric code with no "person" keyword at all', () => {
    expect(detectPersonNumber("What is NM1658's job title?")).toBe('NM1658');
  });

  it('detects a pure numeric ID', () => {
    expect(detectPersonNumber('Look up 300000009119721')).toBe('300000009119721');
  });

  it('returns null when no person identifier is present', () => {
    expect(detectPersonNumber('Show me all absences')).toBe(null);
  });
});

describe('detectSelfReference', () => {
  it('treats "my"/"mine"/"myself" as a genuine self-reference', () => {
    expect(detectSelfReference('Show my absences')).toBe(true);
    expect(detectSelfReference('Is this mine?')).toBe(true);
    expect(detectSelfReference('I did it myself')).toBe(true);
  });

  it('treats "me" as a self-reference when it is not the object of a request verb', () => {
    expect(detectSelfReference('Show absences for me')).toBe(true);
    expect(detectSelfReference('assigned to me')).toBe(true);
  });

  it('does NOT treat "show me"/"tell me"/"give me" as a self-reference (the reported bug)', () => {
    expect(detectSelfReference('Show me all workers')).toBe(false);
    expect(detectSelfReference('Tell me about the Nursing department')).toBe(false);
    expect(detectSelfReference('Give me a list of absences')).toBe(false);
    expect(detectSelfReference('Show me details for person NM1658')).toBe(false);
  });

  it('returns false when there is no "my/me/mine/myself" at all', () => {
    expect(detectSelfReference('Show absences for NM1658')).toBe(false);
  });
});
