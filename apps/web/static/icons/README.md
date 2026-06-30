# App Icons

These icon files are NOT committed to the repository.
They must be generated at deploy time or provided by the designer.

## Required files

| File | Size | Purpose |
|---|---|---|
| `icon-192.png` | 192x192 px | Standard app icon (home screen, splash screen) |
| `icon-512.png` | 512x512 px | High-res app icon (Play Store, App Store previews) |
| `icon-maskable-512.png` | 512x512 px | Maskable icon with safe-area padding for adaptive icon shapes |

## Maskable icon safe area

For `icon-maskable-512.png` the logo must fit entirely within the inner circle
(safe zone = 80% of canvas = 409x409 px centered). The remaining border area
may be clipped by the OS into any shape (circle, squircle, square).

## Colors

- Background: `#0f0f0f` (dark)
- Accent / logo: `#e63012` (timing red)

## Generation (CI example)

```bash
# Using sharp-cli or similar
npx sharp-cli --input logo.svg --output icon-192.png --width 192 --height 192
npx sharp-cli --input logo.svg --output icon-512.png --width 512 --height 512
npx sharp-cli --input logo-padded.svg --output icon-maskable-512.png --width 512 --height 512
```
