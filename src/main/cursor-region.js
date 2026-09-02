// Describes a cursor position as a coarse 3x3 region of its display, for directional
// navigation guidance ("move down and to the left"). Deliberately coarse — Electron
// has no OS-native API for another app's exact window bounds, so pixel-precise
// "click exactly here" guidance isn't achievable without a native addon.
function describeCursorRegion(cursor, displayWorkArea) {
  const relX = (cursor.x - displayWorkArea.x) / displayWorkArea.width;
  const relY = (cursor.y - displayWorkArea.y) / displayWorkArea.height;
  const horizontal = relX < 0.33 ? 'left' : relX > 0.66 ? 'right' : 'center';
  const vertical = relY < 0.33 ? 'top' : relY > 0.66 ? 'bottom' : 'middle';
  return `${vertical}-${horizontal}`;
}

module.exports = { describeCursorRegion };
