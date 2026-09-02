import { describe, it, expect } from 'vitest';
import { checkModelVersion } from '../../src/renderer/model-check.js';

describe('checkModelVersion', () => {
  it('reports up to date when the recommended model is installed', () => {
    const result = checkModelVersion([{ name: 'phi3:mini' }, { name: 'llava:7b' }], 'phi3:mini');
    expect(result.upToDate).toBe(true);
  });

  it('reports out of date with a pull instruction when the recommended model is missing', () => {
    const result = checkModelVersion([{ name: 'llava:7b' }], 'phi3:mini');
    expect(result.upToDate).toBe(false);
    expect(result.message).toContain('ollama pull phi3:mini');
  });
});
