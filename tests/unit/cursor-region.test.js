import { describe, it, expect } from 'vitest';
import { describeCursorRegion } from '../../src/main/cursor-region.js';

const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };

describe('describeCursorRegion', () => {
  it('describes a cursor near the top-left as top-left', () => {
    expect(describeCursorRegion({ x: 50, y: 50 }, DISPLAY)).toBe('top-left');
  });

  it('describes a cursor near the bottom-right as bottom-right', () => {
    expect(describeCursorRegion({ x: 1870, y: 1030 }, DISPLAY)).toBe('bottom-right');
  });

  it('describes a cursor near the center as middle-center', () => {
    expect(describeCursorRegion({ x: 960, y: 540 }, DISPLAY)).toBe('middle-center');
  });

  it('accounts for a non-zero display origin (secondary monitor)', () => {
    const secondaryDisplay = { x: 1920, y: 0, width: 1920, height: 1080 };
    expect(describeCursorRegion({ x: 1970, y: 50 }, secondaryDisplay)).toBe('top-left');
  });
});
