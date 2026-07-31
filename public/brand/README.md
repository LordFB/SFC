# SFC identity

The component-fold mark combines a geometric `S` with the angle and assembly of a code component. The cyan square is the live runtime node: small, active, and deliberately offset.

## Palette

- Ink — `#0a0c0b`
- Signal lime — `#c4ff4d`
- Runtime cyan — `#70e1d1`
- Paper — `#edf2e9`
- Muted — `#657065`

## Assets

- `sfc-mark.svg` — primary square mark
- `sfc-wordmark.svg` — horizontal lockup
- `icons.svg` — SVG symbol sprite (`sfc-mark`, `component`, `route`, `runtime`, `database`, `terminal`, `arrow-up-right`)

Use the lime mark on ink whenever possible. Keep clear space equal to the cyan node around the mark. Do not rotate, recolor individual folds, or add shadows.

UI symbols in `icons.svg` inherit `currentColor`; render them with `fill="none"`, `stroke="currentColor"`, `stroke-width="1.8"`, `stroke-linecap="round"`, and `stroke-linejoin="round"` on the consuming `<svg>`.
