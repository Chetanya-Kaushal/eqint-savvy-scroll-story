import { describe, it, expect } from 'vitest';
import { detectPersonNumber } from '../../src/renderer/person-query-parser.js';

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
