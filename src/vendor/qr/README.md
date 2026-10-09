# QR encoder

A copy of the QR encoder from Lewis Moten's [qr](https://git.lewismoten.com/lewismoten/qr) (`src/js/qr`, commit
43110e0, October 2026), used as is: `create(text, { errorCorrectionLevel })` returns the modules (`size`, `get(row,
column)`). It runs in the browser (the video editor's preview) and in Node (agents drawing QR codes into videos; see
`src/media/qr-image.js`). To update it, copy that folder over this one, keeping this file.
