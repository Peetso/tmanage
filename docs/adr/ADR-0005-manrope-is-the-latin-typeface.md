# ADR-0005 — Manrope is the Latin typeface, and Satoshi cannot be

- **Status:** Accepted
- **Date:** 2026-08-26
- **Deciders:** Implementation lead
- **Governing sources:** `40-DESIGN-SYSTEM-TOKENS-AND-COMPONENTS.md` §1 (the design export
  governs composition where the two disagree); `42-INTERACTION-MOTION-RESPONSIVE-AND-RTL.md`
  (Arabic is a separate face, never a fallback); the design export's own
  `docs/design/source/project/design/tokens/tokens.json` and `tokens.css`
- **Evidence:** `apps/web/src/app/layout.tsx`; `apps/web/src/fonts/Manrope-OFL.txt`;
  `packages/ui/src/styles/tokens.css` (`--font-latin`);
  `packages/ui/tests/tokens.drift.test.ts`

## Context

The design export disagreed with itself about the Latin typeface, and the disagreement was
recorded as an open decision at the end of the UI-001 session. WEB-001 is the first ticket
that has to package a font, so it is the ticket that has to settle it.

- `docs/design/source/project/design/tokens/tokens.json` declares
  `type.family.latin = "Manrope Variable"`, and `tokens.css` declares
  `--font-latin: 'Manrope', system-ui, sans-serif`.
- Every rendered `.dc.html` artboard sets `font-family: Satoshi, Manrope, system-ui,
sans-serif` on `body` and then uses **both**: Satoshi for headings and controls
  (`font: 500 14px/20px Satoshi`), Manrope for prose (`font: 400 14px/21px Manrope`).

So the artboards were drawn with a two-typeface pairing that the token file does not
describe. That is a real divergence, not a typo, and `40-DESIGN-SYSTEM` §1 would ordinarily
give the export's rendered artboards the last word on composition.

Both files are present in the export:

- `docs/design/source/project/uploads/Manrope/` — with `OFL.txt`
- `docs/design/source/project/uploads/Satoshi_Complete/` — with `License/FFL.txt`

## Decision

**Manrope ships, and carries both roles. Satoshi is not packaged.**

The decision is made on licence terms rather than on typographic preference, because the
licences do not leave a choice.

### Satoshi cannot be served from this application

`Satoshi_Complete/License/FFL.txt` is the Fontshare EULA from the Indian Type Foundry. §02,
"Limitations of usage", reads:

> "You are not allowed to transmit the Font Software over the Internet in font serving or for
> font replacement by means of technologies such as but not limited to EOT, Cufon, sIFR or
> similar technologies that may be developed in the future without the prior written consent
> of the Licensor."

A `@font-face` rule serving a `.woff2` from our own origin is font serving over the Internet
by any reading. Without written consent from the licensor, self-hosting Satoshi is a licence
breach, so it was never actually an option for a web application — the "which font ships"
question had one legal answer before it had a design answer.

The remaining route would be the Fontshare API, which the same EULA permits. That is
rejected separately and on its own merits: it puts a third-party origin in the critical
render path of the sign-in screen, where a font CDN would observe every sign-in attempt, and
`04-SECURITY-PRIVACY` treats third-party observation of identity traffic as something to
avoid rather than to accept for a typeface.

### Manrope can

`uploads/Manrope/OFL.txt` is the SIL Open Font License 1.1, which permits redistribution,
embedding and web use. The licence file is copied beside the font at
`apps/web/src/fonts/Manrope-OFL.txt` so it travels with the binary, as OFL §2 requires.

The packaged variable font at `apps/web/src/fonts/Manrope-Variable.ttf` is a byte-identical
copy of `docs/design/source/project/design/assets/fonts/Manrope-Variable.ttf` — SHA-256
`2b7a1ebc80c79246faa1b6e7093c7b91de2a4ceedb9b9a2b2fa05cf9bf8c77cd`.

This also agrees with what is already built: `--font-latin` in `packages/ui/src/styles/`
already names Manrope, and `tokens.drift.test.ts` already pins it to the export's
`tokens.json`. Choosing Satoshi would have required changing a token that the drift test
holds against an immutable artifact, which is a much larger decision than a font swap.

## Consequences

- Headings and controls are set in Manrope rather than Satoshi. The artboards will therefore
  not match the running application at the letterform level. The type **scale** — sizes,
  line heights, weights, tracking — is unchanged, because that lives in `tokens.json` and is
  face-independent.
- `next/font/local` self-hosts the file, so no request leaves for a font host.
- The font is shipped as the export's `.ttf` rather than as a `.woff2`. Converting it would
  mean re-encoding a binary this repository received rather than produced, and no conversion
  tool is installed here. It costs roughly 120 KB of transfer over a `woff2` of the same
  face. Recorded as an open item; it is a build step, not a decision.
- Two faces the tokens name are still unpackaged, and both fall back to a system stack:
  - **Alexandria** (`--font-arabic`). Not in the export at all — the artboards load it from
    Google Fonts. Arabic is not reachable in the application yet, so nothing renders in it.
  - **Geist Mono** (`--font-mono`). Also loaded from Google Fonts by the artboards. Monospaced
    text falls back to the platform's monospace face, which changes the metrics of the
    eyebrow labels but not their meaning.
- If Peter obtains written consent from the Indian Type Foundry, reversing this is small:
  add the `.woff2` and its permission, change `--font-latin`, and update
  `tokens.json`'s expectation — which the drift test will demand, and which cannot be done
  without also confronting the fact that `tokens.json` is immutable source material. That
  last point is the real cost of a reversal, and it belongs in whatever ticket attempts it.
