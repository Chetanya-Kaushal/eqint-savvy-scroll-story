import { describe, it, expect } from 'vitest';
import { isPersonScoped, scopeEndpointsToPerson } from '../../src/renderer/endpoint-scoping.js';

describe('isPersonScoped', () => {
  it('treats Workers, Absences, and Salaries as person-scoped', () => {
    expect(isPersonScoped('/workers')).toBe(true);
    expect(isPersonScoped('/absences')).toBe(true);
    expect(isPersonScoped('/salaries')).toBe(true);
  });

  it('treats Organizations, Locations, and Jobs as reference-only, not person-scoped', () => {
    expect(isPersonScoped('/organizations')).toBe(false);
    expect(isPersonScoped('/locations')).toBe(false);
    expect(isPersonScoped('/jobs')).toBe(false);
  });
});

describe('scopeEndpointsToPerson', () => {
  it('splits a mixed endpoint list into person-scoped and reference-only groups', () => {
    const endpoints = [{ path: '/workers', name: 'Workers' }, { path: '/organizations', name: 'Organizations' }];
    const { personScoped, referenceOnly } = scopeEndpointsToPerson(endpoints);
    expect(personScoped.map((e) => e.path)).toEqual(['/workers']);
    expect(referenceOnly.map((e) => e.path)).toEqual(['/organizations']);
  });
});
