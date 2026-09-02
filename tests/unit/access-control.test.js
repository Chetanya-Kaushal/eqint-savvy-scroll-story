import { describe, it, expect } from 'vitest';
import { classifyOracleError } from '../../src/renderer/access-control.js';

describe('classifyOracleError', () => {
  it('classifies 401 (authentication failure) as hard-stop', () => {
    expect(classifyOracleError(401)).toBe('hard-stop');
  });

  it('classifies 403 (forbidden for this resource) as soft-skip', () => {
    expect(classifyOracleError(403)).toBe('soft-skip');
  });

  it('classifies any other error status as soft-skip (recorded, batch continues)', () => {
    expect(classifyOracleError(404)).toBe('soft-skip');
    expect(classifyOracleError(500)).toBe('soft-skip');
  });
});
