#!/usr/bin/env bash
# Fetch the OCR engine into js/vendor/tesseract/ (gitignored while the OCR spec
# is unruled). Run from the repo root:  bash scripts/fetch-ocr-engine.sh
#
# WHY A SCRIPT AND NOT COMMITTED BINARIES: the payload is the open question in
# the OCR spec, and it is Fauzan's. The harness is committed so anyone can
# reproduce the engine exactly; the 5 MB is not, until he rules. One line in
# .gitignore flips that.
#
# ⚠️ THE FILE SET IS NOT OBVIOUS AND I GOT IT WRONG FIRST. Verified by running
# the real page and reading the network, not by reading docs:
#
#   * createWorker(lang, 1, ...) selects OEM 1 = LSTM only, so the core it asks
#     for is tesseract-core-simd-LSTM, not tesseract-core-simd. Vendoring the
#     latter gives a 404 on '<core>-lstm.wasm.js' and the page reports
#     "gagal: undefined", with the real cause only in the browser console.
#   * The .wasm.js loader EMBEDS its wasm. tesseract-core-simd-lstm.wasm
#     (2.73 MB) is NEVER fetched at runtime, proven by deleting it and watching
#     the page still work. Do not vendor it.
#   * ind.traineddata is vendored RAW, so the page must pass `gzip: false`.
#     tesseract.js otherwise requests ind.traineddata.gz and 404s.
#
# MEASURED runtime payload, from response bodies on a real run: 5.01 MB.
#   tesseract.min.js                   0.06 MB
#   worker.min.js                      0.12 MB
#   tesseract-core-simd-lstm.wasm.js   3.76 MB
#   ind.traineddata                    1.07 MB
set -euo pipefail

TJS=5.1.1
CORE=5.1.1
DEST="js/vendor/tesseract"
mkdir -p "$DEST"

fetch() { echo "  $(basename "$1")"; curl -fsSL --retry 3 -o "$DEST/$(basename "$1")" "$1"; }

echo "fetching the OCR engine into $DEST"
fetch "https://cdn.jsdelivr.net/npm/tesseract.js@${TJS}/dist/tesseract.min.js"
fetch "https://cdn.jsdelivr.net/npm/tesseract.js@${TJS}/dist/worker.min.js"
fetch "https://cdn.jsdelivr.net/npm/tesseract.js-core@${CORE}/tesseract-core-simd-lstm.wasm.js"
# Indonesian, the "fast" model. tessdata_best is ~7.9 MB for accuracy we have
# not shown we need; revisit only with evidence from real documents.
fetch "https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/ind.traineddata"

echo
du -sh "$DEST"
echo "done. Open /lab-ocr.html to use it."
