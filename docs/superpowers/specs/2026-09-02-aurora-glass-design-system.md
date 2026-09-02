# Aurora Glass Design System — Visual Design Spec

**Status:** Approved by user (style direction chosen from three mockups), ready for implementation planning
**Date:** 2026-09-02
**Scope:** Bounded — visual redesign of the existing overlay UI ([src/overlay.html](../../../src/overlay.html)). Independent of the Phase 0–4 enterprise-transformation plans; touches only CSS/markup, no business logic.

## 1. Direction

"Aurora glass" — frosted, gradient-accented, consumer-premium (Linear/Arc-browser register), extending the app's existing indigo→teal brand gradient rather than replacing it. Chosen over "Midnight console" (dark power-user tool) and "Quiet enterprise" (neutral corporate) after reviewing mockups of all three.

## 2. Design Tokens

| Token | Value | Use |
|---|---|---|
| `--brand-gradient` | `linear-gradient(135deg, #6C5CE7, #00C9A7)` | Title bar, primary buttons, user chat bubbles, bubble-mode moon |
| `--color-surface-shell` | `rgba(255,255,255,0.86)` | Main `#app` background (frosted, with `backdrop-filter`) |
| `--color-surface-secondary` | `#F8F9FC` | Inputs, tab bar |
| `--color-surface-bot-bubble` | `#F3F1FE` | Bot chat bubbles |
| `--color-text-primary` | `#101323` | Body text |
| `--color-text-secondary` | `#5B6072` | Supporting text, labels |
| `--color-text-muted` | `#9298A8` | Placeholders, hints |
| `--color-text-bot-bubble` | `#3C3489` | Text on bot bubbles |
| `--color-border` | `rgba(15,23,42,0.08)` | Resting hairline |
| `--color-border-hover` | `rgba(15,23,42,0.16)` | Hover/focus hairline |
| `--color-accent` | `#6C5CE7` | Links, focus rings |
| `--color-accent-hover` | `#5A4BD1` | Accent hover |
| `--radius-shell` | `20px` | Outer `#app` window |
| `--radius-card` | `14px` | Section cards |
| `--radius-control` | `10px` | Inputs, buttons, chat bubbles |
| `--radius-pill` | `999px` | Bubble mode, quick-action chips |
| `--shadow-shell` | `0 20px 60px rgba(31,41,68,0.18)` | Outer window shadow |
| `--shadow-card` | `0 2px 10px rgba(31,41,68,0.06)` | Section/card shadow |
| `--space-{xs,sm,md,lg,xl,2xl}` | `4/8/12/16/20/24px` | Spacing scale |
| `--duration-fast` / `--easing-standard` | `160ms` / `ease-out` | Hover, tab switches |
| `--duration-panel` / `--easing-panel` | `220ms` / `cubic-bezier(0.22,1,0.36,1)` | Accordion sections, bubble expand/collapse |
| `--font-family-base` | `'Inter', -apple-system, 'Segoe UI', sans-serif` | All UI text |

All durations collapse to `0ms` under `@media (prefers-reduced-motion: reduce)`.

## 3. Component Notes

- **Icons**: the current HTML-entity glyphs (`&#8722;`, `&#10005;`, `&#9654;`) render inconsistently across fonts and read as unpolished — replaced with a small hand-authored inline SVG icon set (minimize, close, chevron, send), monoline stroke style, `currentColor`-based so they inherit button text color.
- **Scrollbar**: custom thin (6px) `::-webkit-scrollbar` styling instead of the OS default, matching the frosted aesthetic.
- **Focus rings**: `:focus-visible` gets a 2px accent ring at 40% opacity — accessibility-conscious, not just decorative.
- **Loading state**: the "Discovering..." HCM progress list gets a subtle shimmer skeleton row instead of plain text while waiting for the first result.

## 4. Minimized Bubble Icon

The collapsed/minimized state ([src/overlay.html:216-320](../../../src/overlay.html)) is currently a bespoke "moon in clouds" illustration with its own hardcoded gradient stops, glow shadows, and always-running CSS animations (`float`, `glow`, `twinkle`). Decision: **keep the illustrated moon concept** — it's a distinctive brand moment, not generic chrome — but bring it under the same token system rather than leaving it as a one-off:

- The moon's gradient becomes `var(--brand-gradient)` exactly (currently `linear-gradient(135deg, #0070F3 0%, #00C9A7 50%, #00F5D4 100%)` — a different, older gradient than the rest of the app now uses), so the minimized and expanded states are visibly the same product.
- Glow shadow intensity is reduced to match `--shadow-shell`'s weight rather than the current three-layer `0 0 20px / 0 0 40px / 0 0 60px` neon stack, which reads more "consumer game" than "premium productivity tool."
- All three looping animations (`float`, `glow`, `twinkle`) stop under `prefers-reduced-motion: reduce`, same as every other motion token in this spec — currently they run unconditionally forever, which is both an accessibility gap and unnecessary GPU/battery use for a window that may sit on screen all day.
- A small status dot (`--color-accent` fill, 8px, top-right of the moon) is added but hidden by default (`display: none`) — not activated in this pass, but reserved in the markup/CSS for a future "unread message" indicator so that feature doesn't require another icon redesign later.

## 5. Out of Scope

Dark mode ("Midnight console") is a rejected direction for now, not a deferred one — no dark-mode variant is built in this pass. If requested later, it would reuse this same token structure with a `[data-theme="dark"]` override block, but that's a new brainstorming pass, not an extension of this spec.
