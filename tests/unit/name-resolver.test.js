import { describe, it, expect } from 'vitest';
import { pickDisplayLabel } from '../../src/renderer/name-resolver.js';

describe('pickDisplayLabel', () => {
  it('prefers DisplayName over an earlier-ordered PersonId field', () => {
    const item = { PersonId: '300000009119721', PersonNumber: 'NM1658', DisplayName: 'Jane Smith' };
    expect(pickDisplayLabel(item)).toBe('Jane Smith');
  });

  it('falls back to FirstName + LastName when DisplayName is absent', () => {
    const item = { PersonId: '300000009119721', FirstName: 'Jane', LastName: 'Smith' };
    expect(pickDisplayLabel(item)).toBe('Jane Smith');
  });

  it('never falls back to an ID/code/number field — returns null instead so the caller can show a friendly placeholder', () => {
    const item = { PersonId: '300000009119721', PersonNumber: 'NM1658', AssignmentStatusCode: 'ACTIVE' };
    expect(pickDisplayLabel(item)).toBe(null);
  });

  it('returns null for an item with no usable fields', () => {
    expect(pickDisplayLabel({ _links: [] })).toBe(null);
  });
});
