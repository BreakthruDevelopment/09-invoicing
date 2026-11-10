# Self-hosted fonts

Loaded with `next/font/local` in `../layout.tsx`, so `next build` needs no network access.
All three families are licensed under the SIL Open Font License 1.1 (texts in `LICENSE-*.txt`).
Latin subset, woff2, copied unmodified from the Fontsource npm packages (not installed as dependencies):

| Family | Files | Source package |
| --- | --- | --- |
| Newsreader (variable, wght 200-800) | `newsreader-latin-wght-normal.woff2` | `@fontsource-variable/newsreader@5.3.0` |
| Public Sans (variable, wght 100-900) | `public-sans-latin-wght-normal.woff2` | `@fontsource-variable/public-sans@5.3.0` |
| IBM Plex Mono (400, 500) | `ibm-plex-mono-latin-400-normal.woff2`, `ibm-plex-mono-latin-500-normal.woff2` | `@fontsource/ibm-plex-mono@5.3.0` |

To update: `npm pack <package>@<version>`, copy the matching `files/*-latin-*.woff2` and `LICENSE`, and bump the versions above.
