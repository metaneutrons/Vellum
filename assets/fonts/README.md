# Render fonts

Every face the server-side renderers draw with. `src/lib/render/fonts.ts` registers
them; nothing here is loaded from the host system, so a display looks the same
whatever the container runs on. The whole directory ships in the image
(`Dockerfile`, `COPY --from=builder /app/assets ./assets`), licence files included.

The version and licence columns are read out of each font's own `name` table, not
copied from a download page, so they say what the vendor declared rather than what
someone assumed.

| File                               | Family                  | Version              | Licence | Text                                    |
| ---------------------------------- | ----------------------- | -------------------- | ------- | --------------------------------------- |
| `Inter-Regular.ttf`                | Inter                   | 4.001, git-9221beed3 | OFL 1.1 | `licenses/Inter-OFL.txt`                |
| `Inter-Medium.ttf`                 | Inter                   | 4.001, git-9221beed3 | OFL 1.1 | `licenses/Inter-OFL.txt`                |
| `Inter-Bold.ttf`                   | Inter                   | 4.001, git-9221beed3 | OFL 1.1 | `licenses/Inter-OFL.txt`                |
| `IBMPlexSansCondensed-Regular.ttf` | IBM Plex Sans Condensed | 3.000                | OFL 1.1 | `licenses/IBMPlexSansCondensed-OFL.txt` |
| `IBMPlexSansCondensed-Bold.ttf`    | IBM Plex Sans Condensed | 3.000                | OFL 1.1 | `licenses/IBMPlexSansCondensed-OFL.txt` |
| `PixelOperator.ttf`                | Pixel Operator          | 2018.10.04-1         | CC0 1.0 | `licenses/PixelOperator-CC0.txt`        |
| `PixelOperator-Bold.ttf`           | Pixel Operator Bold     | 2018.10.04-1         | CC0 1.0 | `licenses/PixelOperator-CC0.txt`        |
| `PixelOperatorHB.ttf`              | Pixel Operator HB       | 2018.10.04-1         | CC0 1.0 | `licenses/PixelOperator-CC0.txt`        |
| `PixelOperatorHBSC.ttf`            | Pixel Operator HB SC    | 2018.10.04-1         | CC0 1.0 | `licenses/PixelOperator-CC0.txt`        |

Sources: Inter from [rsms/inter](https://github.com/rsms/inter), IBM Plex Sans
Condensed from [IBM/plex](https://github.com/IBM/plex)
(`packages/plex-sans-condensed/fonts/complete/ttf/`), Pixel Operator from
[Jayvee Enaguas](https://www.dafont.com/pixel-operator.font). The OFL requires its
text to accompany the font; CC0 does not, and Pixel Operator's is here anyway so
that no face in this directory is unaccounted for.

## Which face is used for what

- **Inter** is the body family for every renderer: room names, captions, given
  names, states, footers.
- **IBM Plex Sans Condensed** is registered under the neutral family name
  `Vellum Narrow` and used for ONE rank, the surname on a name plate, and only when
  it yields a larger surname than Inter would. Where the panel's height is the
  binding constraint rather than its width, Inter wins the tie and the sign stays in
  a single face. See `name-plate-sizes.ts` (`choosePlan`).
- **Pixel Operator** is not used by the current renderers. It predates them and is
  kept because the flash and simulator tooling references the directory as a whole.

Two things about the condensed face are measured rather than assumed, and both are
worth knowing before swapping it:

- **Static cuts, not a variable font.** Asked for `bold`, a variable font produces
  identical ink on this canvas (ratio 1.000), because Skia does not instance the
  `wght` axis here; these two static files give 1.74. The surname is bold, so the
  93 kB `ArchivoNarrow[wght].ttf` and the 372 kB `RobotoCondensed[wght].ttf` are
  both unusable on their own, and Google Fonts no longer ships statics for either.
- **The gain is 11 to 18 %, about 16 % on average**, measured against Inter Bold on
  real names. An earlier estimate of "about 20 %" was optimistic.

To swap the narrow face, replace the two files and the one filename array in
`src/lib/render/fonts.ts`. The family name stays `Vellum Narrow`, so no renderer
changes: a door sign asks for "the narrow face", not for a brand.
