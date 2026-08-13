#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#
# Regenerate the confirmation chime played by displays that have a real speaker.
#
#   ./assets/render-audio.sh [path-to-source.mp3]
#
# Requires: ffmpeg, ffprobe, python3.
#
# ── Source and licence ────────────────────────────────────────────────
#
# "Correct Choice", Pixabay sound effect 43861, uploaded by the
# `freesound_community` account:
#
#   https://pixabay.com/sound-effects/correct-choice-43861/
#
# Pixabay Content License: commercial use permitted, no attribution required,
# modification permitted. It does forbid redistributing the asset as a standalone
# stock download, which is why only the transformed PCM is committed here and the
# source MP3 is not — the array below is a 272 ms mono derivative baked into
# firmware, not a redistributable sound file. Re-download the original from the URL
# above to regenerate.
#
# ── Why raw PCM ───────────────────────────────────────────────────────
#
# The chime is played by writing straight to I2S. An MP3 would need a decoder in
# firmware to save 8 KB of flash on a part that has megabytes of it — the decoder
# costs more than the saving, and adds a failure mode to a beep.
#
# ── Why these parameters ──────────────────────────────────────────────
#
#   16 kHz    the rate Seeed's own ES8311 example uses, and comfortably above what
#             a 2 W mono speaker resolves; 8 kHz of bandwidth for a chime
#   mono      the D1001 speaker is mono, and the ES8311 is a mono codec
#   s16le     what the I2S channel is configured for, so no conversion on device
#   -1 dBFS   peak-normalised with 1 dB of headroom, measured rather than guessed
#
# The source is 24 kHz stereo, 0.528 s, of which only 0.272 s is sound: 46 ms of
# leading silence and 210 ms of trailing silence. On a chime used as button
# feedback the leading silence is the part that matters — it reads as lag between
# pressing the button and hearing anything.
set -Eeuo pipefail

SRC="${1:-$HOME/Downloads/freesound_community-correct-choice-43861.mp3}"
ASSETS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${ASSETS}/../firmware/components/vellum_audio/chime_pcm.c"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
[[ -f "$SRC" ]] || {
  echo "Source audio not found: $SRC" >&2
  echo "Download 'Correct Choice' from https://pixabay.com/sound-effects/correct-choice-43861/" >&2
  exit 1
}

SILENCE="silenceremove=start_periods=1:start_threshold=-45dB:detection=peak"

# Trim both ends: silenceremove only strips leading silence, so the tail is
# handled by reversing, stripping again, and reversing back.
ffmpeg -hide_banner -v error -y -i "$SRC" \
  -af "${SILENCE},areverse,${SILENCE},areverse,aresample=16000" \
  -ac 1 -c:a pcm_s16le "${WORK}/trimmed.wav"

# Peak-normalise from a measurement, not a guess: apply exactly the gain that puts
# the loudest sample at -1 dBFS.
peak="$(ffmpeg -hide_banner -v info -i "${WORK}/trimmed.wav" -af volumedetect -f null - 2>&1 \
  | sed -n 's/.*max_volume: \(-*[0-9.]*\) dB.*/\1/p')"
[[ -n "$peak" ]] || { echo "could not measure peak level" >&2; exit 1; }
gain="$(python3 -c "print(f'{-1.0 - float('$peak'):.2f}')")"
echo "  peak ${peak} dB → applying ${gain} dB"

ffmpeg -hide_banner -v error -y -i "${WORK}/trimmed.wav" \
  -af "volume=${gain}dB" -ac 1 -ar 16000 -f s16le "${WORK}/chime.raw"

python3 - "${WORK}/chime.raw" "$OUT" <<'PY'
import struct, sys

raw, out = sys.argv[1], sys.argv[2]
with open(raw, "rb") as fh:
    data = fh.read()
samples = struct.unpack(f"<{len(data) // 2}h", data[: len(data) // 2 * 2])

lines = []
for i in range(0, len(samples), 12):
    lines.append("    " + " ".join(f"{v}," for v in samples[i : i + 12]))

with open(out, "w") as fh:
    fh.write(f"""// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Confirmation chime — GENERATED, DO NOT EDIT.
 *
 * Regenerate with assets/render-audio.sh, which documents the source, its licence
 * and every conversion parameter.
 *
 * "Correct Choice", Pixabay sound effect 43861 (freesound_community), trimmed to
 * its {len(samples) / 16000:.3f} s of actual signal, mono, peak-normalised to -1 dBFS.
 */
#include <stdint.h>

const uint32_t vellum_chime_sample_rate = 16000;
const uint32_t vellum_chime_sample_count = {len(samples)};

const int16_t vellum_chime_pcm[{len(samples)}] = {{
""")
    fh.write("\n".join(lines))
    fh.write("\n};\n")

print(f"  {out.rsplit('/', 1)[-1]}  {len(samples)} samples, "
      f"{len(samples) * 2} bytes, {len(samples) / 16000:.3f} s")
PY
