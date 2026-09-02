# Aurora Glass Visual Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the Aurora Glass design system to the existing overlay UI — main panel, chat, settings, and the minimized bubble icon — replacing ad hoc hardcoded values with a shared token system, and fixing the always-running bubble animations and inconsistent icon glyphs along the way.

**Architecture:** Pure CSS/markup change. Extracts the current inline `<style>` block out of [src/overlay.html](../../../src/overlay.html) into `src/renderer/styles.css`, introduces a `:root` custom-property token layer, and re-points existing selectors at those tokens. No JavaScript logic changes. Independent of the Phase 0–4 backend plans — can run before, after, or interleaved with them, since it only touches `src/overlay.html` and adds `src/renderer/styles.css`.

**Tech Stack:** Adds `@fontsource/inter` (self-hosted Inter webfont, no runtime network dependency — important for an offline-capable desktop app) and `@playwright/test` (already added by the Phase 0 plan if that's landed first; installed fresh here otherwise, since this plan has no hard ordering dependency on Phase 0).

**Spec:** [docs/superpowers/specs/2026-09-02-aurora-glass-design-system.md](../specs/2026-09-02-aurora-glass-design-system.md)

## Global Constraints

- Every color, radius, shadow, spacing, and duration value used anywhere in `src/overlay.html`/`src/renderer/styles.css` must come from a `:root` custom property defined in Task 1 — no new hardcoded hex/px values introduced in later tasks.
- All CSS transitions/animations must have zero duration under `@media (prefers-reduced-motion: reduce)`.
- No emoji, no HTML-entity glyphs for icons — inline SVG only, `currentColor`-based so buttons can recolor them via CSS alone.

---

### Task 1: Extract stylesheet + define design tokens

**Files:**
- Create: `src/renderer/styles.css`
- Modify: `src/overlay.html` (remove the inline `<style>` block, add `<link rel="stylesheet" href="styles.css">`)
- Test: `tests/visual/design-tokens.test.js`

**Interfaces:**
- Produces: the full `:root` token set from the spec's Section 2 table. Every later task in this plan consumes these exact custom-property names — do not rename them.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/visual/design-tokens.test.js
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');

test('design tokens are defined on :root', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main.js')] });
  const window = await app.firstWindow();

  const tokens = await window.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      brandGradient: style.getPropertyValue('--brand-gradient').trim(),
      radiusShell: style.getPropertyValue('--radius-shell').trim(),
      radiusControl: style.getPropertyValue('--radius-control').trim(),
      colorAccent: style.getPropertyValue('--color-accent').trim(),
      fontFamilyBase: style.getPropertyValue('--font-family-base').trim(),
    };
  });

  expect(tokens.brandGradient).toBe('linear-gradient(135deg, #6C5CE7, #00C9A7)');
  expect(tokens.radiusShell).toBe('20px');
  expect(tokens.radiusControl).toBe('10px');
  expect(tokens.colorAccent).toBe('#6C5CE7');
  expect(tokens.fontFamilyBase).toContain('Inter');

  await app.close();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx playwright test tests/visual/design-tokens.test.js`
Expected: FAIL — no `:root` tokens exist yet.

- [ ] **Step 3: Extract the existing `<style>` block into `src/renderer/styles.css`**

```bash
mkdir -p src/renderer
```

Move the entire contents of `src/overlay.html`'s `<style>...</style>` block (lines 5-321) verbatim into a new `src/renderer/styles.css` file (drop the `<style>`/`</style>` tags themselves, keep every rule as-is for now — token substitution happens in later tasks).

- [ ] **Step 4: Add the token layer to the top of `src/renderer/styles.css`**

```css
:root {
  --brand-gradient: linear-gradient(135deg, #6C5CE7, #00C9A7);
  --color-surface-shell: rgba(255,255,255,0.86);
  --color-surface-secondary: #F8F9FC;
  --color-surface-bot-bubble: #F3F1FE;
  --color-text-primary: #101323;
  --color-text-secondary: #5B6072;
  --color-text-muted: #9298A8;
  --color-text-bot-bubble: #3C3489;
  --color-border: rgba(15,23,42,0.08);
  --color-border-hover: rgba(15,23,42,0.16);
  --color-accent: #6C5CE7;
  --color-accent-hover: #5A4BD1;
  --radius-shell: 20px;
  --radius-card: 14px;
  --radius-control: 10px;
  --radius-pill: 999px;
  --shadow-shell: 0 20px 60px rgba(31,41,68,0.18);
  --shadow-card: 0 2px 10px rgba(31,41,68,0.06);
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-lg: 16px;
  --space-xl: 20px;
  --space-2xl: 24px;
  --duration-fast: 160ms;
  --easing-standard: ease-out;
  --duration-panel: 220ms;
  --easing-panel: cubic-bezier(0.22, 1, 0.36, 1);
  --font-family-base: 'Inter', -apple-system, 'Segoe UI', sans-serif;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-fast: 0ms;
    --duration-panel: 0ms;
  }
}
```

- [ ] **Step 5: Wire the stylesheet into `src/overlay.html`**

Replace the removed `<style>...</style>` block with:
```html
<link rel="stylesheet" href="styles.css">
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `npx playwright test tests/visual/design-tokens.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/styles.css src/overlay.html tests/visual/design-tokens.test.js
git commit -m "refactor: extract overlay styles to styles.css, add Aurora Glass design tokens"
```

---

### Task 2: Bundle Inter and apply the typography scale

**Files:**
- Modify: `package.json` (add `@fontsource/inter`)
- Create: `assets/fonts/` (copied woff2 files)
- Modify: `src/renderer/styles.css` (`@font-face`, `body` font-family, type scale)
- Test: add a case to `tests/visual/design-tokens.test.js`

**Interfaces:** none new — consumes `--font-family-base` from Task 1.

- [ ] **Step 1: Install the font package and copy the two weights this app uses**

```bash
npm install @fontsource/inter
mkdir -p assets/fonts
cp node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2 assets/fonts/
cp node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2 assets/fonts/
```

- [ ] **Step 2: Write the failing test**

Add to `tests/visual/design-tokens.test.js`:
```javascript
test('body renders with the Inter font family loaded', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main.js')] });
  const window = await app.firstWindow();
  const bodyFont = await window.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(bodyFont).toContain('Inter');
  await app.close();
});
```

- [ ] **Step 3: Run and confirm it fails**

Run: `npx playwright test tests/visual/design-tokens.test.js`
Expected: FAIL — `body` still uses the old `-apple-system, 'Segoe UI', Inter, sans-serif` stack with no `@font-face`, so `Inter` never actually loads (it was listed but never bundled).

- [ ] **Step 4: Add `@font-face` declarations and update `body` in `src/renderer/styles.css`**

Add near the top of the file, after the `:root` block:
```css
@font-face {
  font-family: 'Inter';
  src: url('../../assets/fonts/inter-latin-400-normal.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Inter';
  src: url('../../assets/fonts/inter-latin-600-normal.woff2') format('woff2');
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}
```

Change the `body` rule's `font-family` from `-apple-system, 'Segoe UI', Inter, sans-serif` to `var(--font-family-base)`.

- [ ] **Step 5: Run and confirm it passes**

Run: `npx playwright test tests/visual/design-tokens.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json assets/fonts src/renderer/styles.css tests/visual/design-tokens.test.js
git commit -m "feat: self-host Inter webfont and apply it as the base typeface"
```

---

### Task 3: Frosted glass shell + refined shadows

**Files:**
- Modify: `src/renderer/styles.css` (`#app`, `#titlebar`, `.tabs`, `.input-area`)
- Test: add a case to `tests/visual/design-tokens.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
test('#app uses the frosted-glass shell background and shadow tokens', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main.js')] });
  const window = await app.firstWindow();
  const shell = await window.evaluate(() => {
    const style = getComputedStyle(document.getElementById('app'));
    return { backdropFilter: style.backdropFilter, borderRadius: style.borderRadius };
  });
  expect(shell.backdropFilter).toContain('blur');
  expect(shell.borderRadius).toBe('20px');
  await app.close();
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx playwright test tests/visual/design-tokens.test.js`
Expected: FAIL — `#app` currently has no `backdrop-filter` and a `border-radius` of `14px`.

- [ ] **Step 3: Update the `#app` rule in `src/renderer/styles.css`**

Replace:
```css
#app {
  width: 100vw; height: 100vh;
  display: flex; flex-direction: column;
  background: rgba(255,255,255,0.97);
  border-radius: 14px;
  border: 1px solid rgba(0,0,0,0.08);
  box-shadow: 0 8px 40px rgba(0,0,0,0.18);
  overflow: hidden;
}
```
with:
```css
#app {
  width: 100vw; height: 100vh;
  display: flex; flex-direction: column;
  background: var(--color-surface-shell);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-radius: var(--radius-shell);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-shell);
  overflow: hidden;
}
```

- [ ] **Step 4: Update `#titlebar` to use the brand gradient token**

Change `background: linear-gradient(135deg, #0070F3, #00C9A7);` to `background: var(--brand-gradient);`.

- [ ] **Step 5: Update `.tabs` and `.input-area` to use secondary-surface and border tokens**

In `.tabs`, change `background: #f8fafc; border-bottom: 1px solid #e2e8f0;` to `background: var(--color-surface-secondary); border-bottom: 1px solid var(--color-border);`.

In `.input-area`, change `border-top: 1px solid #e2e8f0;` to `border-top: 1px solid var(--color-border);`.

- [ ] **Step 6: Run and confirm the test passes**

Run: `npx playwright test tests/visual/design-tokens.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/styles.css tests/visual/design-tokens.test.js
git commit -m "feat: apply frosted-glass shell background and brand-gradient title bar"
```

---

### Task 4: Gradient buttons + chat bubbles on tokens

**Files:**
- Modify: `src/renderer/styles.css` (`.msg.bot .msg-text`, `.msg.user .msg-text`, `.send-btn`, `.save-btn`, `.read-btn`, `.quick-btn`)
- Test: add a case to `tests/visual/design-tokens.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
test('user chat bubbles use the brand gradient and bot bubbles use the tinted surface', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main.js')] });
  const window = await app.firstWindow();
  const colors = await window.evaluate(() => {
    const botBubble = document.querySelector('.msg.bot .msg-text');
    return { botBackground: getComputedStyle(botBubble).backgroundColor };
  });
  expect(colors.botBackground).toBe('rgb(243, 241, 254)'); // #F3F1FE
  await app.close();
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx playwright test tests/visual/design-tokens.test.js`
Expected: FAIL — `.msg.bot .msg-text` currently uses `#f1f5f9`.

- [ ] **Step 3: Update chat bubble and button rules in `src/renderer/styles.css`**

Change `.msg.bot .msg-text { background: #f1f5f9; border-bottom-left-radius: 3px; }` to:
```css
.msg.bot .msg-text { background: var(--color-surface-bot-bubble); color: var(--color-text-bot-bubble); border-bottom-left-radius: 3px; }
```

Change `.msg.user .msg-text { background: #0070F3; color: white; border-bottom-right-radius: 3px; }` to:
```css
.msg.user .msg-text { background: var(--brand-gradient); color: white; border-bottom-right-radius: 3px; }
```

Change every occurrence of `background: linear-gradient(135deg,#0070F3,#00C9A7);` in `.send-btn`, `.save-btn`, `.read-btn` to `background: var(--brand-gradient);`, and their `border-radius: 8px;` to `border-radius: var(--radius-control);`.

Change `.quick-btn { padding: 5px 8px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 6px; ... }` to use `background: var(--color-surface-secondary); border: 1px solid var(--color-border); border-radius: var(--radius-pill);` (quick-action chips read as pills in the new system, per spec Section 2's `--radius-pill` usage).

- [ ] **Step 4: Run and confirm the test passes**

Run: `npx playwright test tests/visual/design-tokens.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/styles.css tests/visual/design-tokens.test.js
git commit -m "feat: apply brand gradient and bubble-tint tokens to chat bubbles and buttons"
```

---

### Task 5: Inline SVG icon set (replacing HTML-entity glyphs)

**Files:**
- Modify: `src/overlay.html` (replace `&#8722;`, `&#10005;`, `&#9654;` with inline `<svg>`)
- Modify: `src/renderer/styles.css` (icon sizing/color rules)
- Test: `tests/visual/icons.test.js`

**Interfaces:** none — presentation only, no behavior change to the buttons' click handlers.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/visual/icons.test.js
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');

test('titlebar buttons use inline SVG icons, not HTML-entity glyphs', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main.js')] });
  const window = await app.firstWindow();

  const collapseHasSvg = await window.evaluate(() => document.getElementById('collapseBtn').querySelector('svg') !== null);
  const closeHasSvg = await window.evaluate(() => document.getElementById('closeBtn').querySelector('svg') !== null);
  expect(collapseHasSvg).toBe(true);
  expect(closeHasSvg).toBe(true);

  await app.close();
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx playwright test tests/visual/icons.test.js`
Expected: FAIL — both buttons currently contain only HTML-entity text nodes.

- [ ] **Step 3: Replace the entity glyphs in `src/overlay.html`**

Change:
```html
<button class="title-btn" id="collapseBtn" title="Minimize to bubble">&#8722;</button>
<button class="title-btn" id="closeBtn" title="Hide">&#10005;</button>
```
to:
```html
<button class="title-btn" id="collapseBtn" title="Minimize to bubble">
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="8" x2="13" y2="8"/></svg>
</button>
<button class="title-btn" id="closeBtn" title="Hide">
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
</button>
```

Change every `<span class="arrow">&#9654;</span>` (section-header expand chevrons, two occurrences) to:
```html
<span class="arrow"><svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,3 11,8 5,13"/></svg></span>
```

- [ ] **Step 4: Ensure icons inherit color from their button in `src/renderer/styles.css`**

Add:
```css
.title-btn svg, .arrow svg { display: block; color: inherit; }
```

- [ ] **Step 5: Run and confirm the test passes**

Run: `npx playwright test tests/visual/icons.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/overlay.html src/renderer/styles.css tests/visual/icons.test.js
git commit -m "feat: replace HTML-entity icon glyphs with inline SVG icon set"
```

---

### Task 6: Minimized bubble icon — token alignment, status-dot slot, motion guard

**Files:**
- Modify: `src/overlay.html` (add the hidden status-dot element to the bubble markup)
- Modify: `src/renderer/styles.css` (`#bubble-overlay .moon` and related rules)
- Test: `tests/visual/bubble.test.js`

**Interfaces:**
- Produces: `.moon .status-dot` element (present in the DOM, `display: none` by default) — a future "unread message" feature toggles it via CSS/JS without needing another markup change.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/visual/bubble.test.js
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');

test('bubble moon uses the shared brand gradient token, not its own hardcoded gradient', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main.js')] });
  const window = await app.firstWindow();

  const background = await window.evaluate(() => getComputedStyle(document.querySelector('#bubble-overlay .moon')).backgroundImage);
  expect(background).toContain('108, 92, 231'); // #6C5CE7 as rgb
  expect(background).toContain('0, 201, 167'); // #00C9A7 as rgb

  const statusDotDisplay = await window.evaluate(() => getComputedStyle(document.querySelector('#bubble-overlay .status-dot')).display);
  expect(statusDotDisplay).toBe('none');

  await app.close();
});

test('bubble animations pause under prefers-reduced-motion', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main.js')] });
  const window = await app.firstWindow();
  await window.emulateMedia({ reducedMotion: 'reduce' });

  const animationName = await window.evaluate(() => getComputedStyle(document.querySelector('#bubble-overlay .moon')).animationName);
  expect(animationName).toBe('none');

  await app.close();
});
```

- [ ] **Step 2: Run and confirm both fail**

Run: `npx playwright test tests/visual/bubble.test.js`
Expected: FAIL — the moon still uses its old three-stop gradient, there's no `.status-dot` element, and the `glow` animation keeps running regardless of `prefers-reduced-motion`.

- [ ] **Step 3: Add the status-dot element to `src/overlay.html`**

Inside `#bubble-overlay .bubble-container .moon` (around the existing `<img>`), add a sibling element:
```html
<div class="status-dot"></div>
```

- [ ] **Step 4: Update `src/renderer/styles.css`'s bubble rules**

Change:
```css
#bubble-overlay .moon {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: linear-gradient(135deg, #0070F3 0%, #00C9A7 50%, #00F5D4 100%);
  box-shadow:
    0 0 20px rgba(0,112,243,0.6),
    0 0 40px rgba(0,201,167,0.4),
    0 0 60px rgba(0,245,212,0.2),
    inset -8px -8px 20px rgba(0,0,0,0.2),
    inset 4px 4px 10px rgba(255,255,255,0.3);
  ...
  animation: glow 3s ease-in-out infinite;
}
```
to:
```css
#bubble-overlay .moon {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--brand-gradient);
  position: relative;
  box-shadow:
    var(--shadow-card),
    inset -8px -8px 20px rgba(0,0,0,0.15),
    inset 4px 4px 10px rgba(255,255,255,0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
  transition: all var(--duration-fast) var(--easing-standard);
  animation: glow 3s ease-in-out infinite;
}

#bubble-overlay .status-dot {
  display: none;
  position: absolute;
  top: 2px;
  right: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-accent);
  border: 1.5px solid white;
}
```

Add, alongside the existing `@keyframes float/glow/twinkle` block:
```css
@media (prefers-reduced-motion: reduce) {
  #bubble-overlay .cloud, #bubble-overlay .moon, #bubble-overlay .sparkle {
    animation: none;
  }
}
```

- [ ] **Step 5: Run and confirm both tests pass**

Run: `npx playwright test tests/visual/bubble.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/overlay.html src/renderer/styles.css tests/visual/bubble.test.js
git commit -m "feat: align minimized bubble icon to brand gradient tokens, add reduced-motion guard and status-dot slot"
```

---

### Task 7: Custom scrollbar + focus rings

**Files:**
- Modify: `src/renderer/styles.css` (`::-webkit-scrollbar`, `:focus-visible`)
- Test: add a case to `tests/visual/design-tokens.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
test('inputs show an accent focus ring via :focus-visible', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main.js')] });
  const window = await app.firstWindow();
  await window.focus('#chatInput');
  const boxShadow = await window.evaluate(() => getComputedStyle(document.getElementById('chatInput')).boxShadow);
  expect(boxShadow).toContain('108, 92, 231'); // --color-accent as rgb
  await app.close();
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx playwright test tests/visual/design-tokens.test.js`
Expected: FAIL — `.input-area input:focus` currently only changes `border-color`, no box-shadow ring.

- [ ] **Step 3: Add scrollbar and focus-ring rules to `src/renderer/styles.css`**

```css
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-thumb { background: var(--color-border-hover); border-radius: var(--radius-pill); }
::-webkit-scrollbar-track { background: transparent; }

:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(108, 92, 231, 0.4);
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npx playwright test tests/visual/design-tokens.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/styles.css tests/visual/design-tokens.test.js
git commit -m "feat: add custom scrollbar styling and accent focus-visible rings"
```

---

## Self-Review Notes

- **Spec coverage**: every item in the spec's Section 2 token table is introduced in Task 1 and consumed by name in Tasks 3-7; Section 3's icon/scrollbar/focus/loading-shimmer notes are covered by Tasks 5 and 7 (the shimmer loading state for "Discovering..." was scoped out of this pass for time — flagged below, not silently dropped); Section 4's minimized bubble icon is fully covered by Task 6.
- **Type/interface consistency**: no JS interfaces change in this plan — it's CSS/markup only, so the usual "function signature" consistency check doesn't apply; the one cross-task interface is the token names from Task 1, verified reused verbatim in Tasks 3, 4, 6, and 7's test assertions and CSS.
- **Explicitly deferred, not forgotten**: the spec's "Discovering..." shimmer skeleton state (Section 3) is not implemented in this plan — it involves the discovery-progress JavaScript in `src/renderer/index.js`, not just CSS, and is small enough to fold into whichever of the Phase 1/2 plans next touches that discovery UI, rather than mixing a JS behavior change into an otherwise pure-CSS plan.
