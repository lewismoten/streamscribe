# ocr-slides

Script: [`ocr-slides.js`](../../src/media/ocr-slides.js)

Command:

```bash
npm run ocr-slides -- [--session <folder> | --slides <folder>] [--model deepseek-ocr:3b] [--ollama <url>] [--again]
```

Reads the text on each slide [extract-slides](extract-slides.md) saved, with a vision model on an
[Ollama](https://ollama.com) server: by default DeepSeek OCR (`ollama pull deepseek-ocr:3b`) on this machine. It reads
headings, lists, tables, and small print well, a few seconds a slide on a recent Mac.

Each slide's text goes into `slides/slides.json` (`text`, and `textModel`, the model that read it), saved after each
slide, so a stopped run keeps what it read and picks up where it stopped. Slides already read are skipped unless
`--again`. `publish-library` (and a recorder, after a meeting) sends the slides to the hub with their text: the
meeting's page shows them in its **Slides** panel, findable by the words on them, and small pictures of up to five
slides beside each chapter they were shown in.

Options:

- `--session <folder>` (default: the most recently updated capture; `--source <key>` limits the search to one source),
  or `--slides <folder>` for a slides folder itself
- `--model <name>`: any vision model the Ollama server has (`config.ocr.model`, `deepseek-ocr:3b` unless set)
- `--ollama <url>`: the server (`config.ocr.ollamaUrl`, `http://127.0.0.1:11434` unless set)
- `--again`: read every slide again (after changing the model, say)
