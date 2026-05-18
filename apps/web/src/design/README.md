# Novan Spatial Design System

Premium · minimal · cinematic · operational.

## Rules

1. **Tokens, not hex.** Use CSS vars from `index.css` or constants from
   `tokens.ts`. Raw hex in component code is a smell — fix it.
2. **No purple AI.** Lavender is reserved for `paused` state. No purple
   gradients, no purple accents, no purple anywhere else.
3. **Operational accents only.** Healthy / Active / Warning / Critical /
   Paused. Never decorative. Never rainbow.
4. **Glass for overlays.** Use `.glass` / `.glass-strong` / `.drawer-edge`
   for floating surfaces. Use `.panel` for solid base panels.
5. **Motion is intentional.** Use `var(--ease-out)` for entrances,
   `var(--ease-in-out)` for symmetric transitions, `var(--ease-spring)`
   sparingly. Durations: `--dur-fast` for hovers, `--dur-base` for panel
   animations, `--dur-camera` for camera moves.
6. **Z-index has 7 named layers.** Never pick raw z-index values:
   `--z-universe` (0) < `orbit` (10) < `overlay` (20) < `drawer` (30) <
   `dropdown` (40) < `modal` (50) < `command` (60).
7. **Density: 10/11/13/14.** Most text is `2xs` (10), `xs` (11), or
   `sm` (13). Display goes to `14-22`. Tighter than typical web because
   operators read fast.
8. **Hide before showing.** Progressive disclosure: dropdowns over
   sidebars. Drawers over modals. Hover to reveal detail.
9. **Reduced motion respected.** Every animation gates on
   `prefers-reduced-motion: reduce`. R3F frameloop drops to `demand`.

## Color hierarchy

```
charcoal (void → bg → surface → elevated)
silver/soft-white (text-primary → secondary → muted → faint)
operational accents (healthy emerald, active cyan, warning amber,
                     critical red, paused lavender)
```

## Files

- `src/index.css` — CSS variables (single source of truth) + component layer
- `src/design/tokens.ts` — JS mirror for R3F / SVG / charts
- `src/design/components.tsx` — GlassPanel · StatusPill · StatusDot ·
  Dropdown · Drawer · KV · SectionLabel · Empty · Skeleton · CommandBar
- `src/design/audio.ts` — opt-in WebAudio tones (select / open / confirm /
  reject / critical / success). Off by default; honors prefers-reduced-motion.
- `src/design/ui-mode.tsx` — Focus / Executive / Security / Creative /
  Runtime / Mission. Each shifts accent + emphasis without changing data.
- `tailwind.config.ts` — Tailwind named classes mapped to tokens

## URL conventions

- `?screenshot=1` — hides app sidebar + top-controls + Brain overlays.
  Use for marketing shots and design review at exact viewport sizes.
- `?replay_at=TS&node=ID&template=X&focus=Y` — Brain deep-link from
  any War Room surface (Audit Trail, Proposals, etc.).

## Adding a new page

1. Wrap in `<div className="bg-bg text-primary">` or use existing root layout.
2. Use `<GlassPanel>` / `<CommandBar>` / `<Drawer>` from `design/components`.
3. Use `<StatusPill>` / `<StatusDot>` for any health indicator.
4. Use `text-muted`/`text-secondary`/`text-primary` instead of `text-white/40` etc.
5. Use `bg-surface`/`bg-elevated` instead of `bg-[#111]`.

## Anti-patterns

- ❌ `text-white/40`, `bg-black/60`, hex literals → ✅ tokens
- ❌ Purple gradients, neon glow, holographic effects
- ❌ Three font sizes for the same density tier
- ❌ Different border colors per page
- ❌ Animation > 600ms on UI (camera moves can go to 800ms)
- ❌ Auto-firing critical actions without CONFIRM modal
