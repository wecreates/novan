Save the Novan brand PNG (metallic N on black background) to this folder as:

    apps/web/public/icon.png

The HTML and web manifest already reference /icon.png. Once saved:
- Browser favicon will use it
- iOS "Add to Home Screen" will use it
- PWA install will use it
- Desktop icon (when installed as PWA via Chrome/Edge "Install app") will use it

The icon.svg in this folder is a lightweight fallback used when the PNG is
absent. Both are referenced in index.html and manifest.webmanifest.

Recommended PNG specs:
  - 512 × 512 px (minimum)
  - PNG with transparent or solid black background
  - High resolution preferred for retina displays
