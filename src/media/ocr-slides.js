import fs from 'fs';
import path from 'path';
import { OCR } from '../config/runtime-config.js';
import { writeJsonAtomically } from '../util/fs-utils.js';
import { findLatestSession } from './extract-slides.js';

// Reads the text on each slide extract-slides saved, with a vision model on an Ollama server (DeepSeek OCR unless
// config.local.js says otherwise: ocr.ollamaUrl, ocr.model): each slide's text goes into slides.json (`text`, with the
// model that read it), saved after each slide so a stopped run keeps what it read and picks up there. publish-library
// sends the text with the slides, so the web app can show and search it.
//   npm run ocr-slides -- [--session <folder> | --slides <folder>] [--model deepseek-ocr:3b] [--ollama <url>] [--again]

function parseArgs(argv) {
  const options = { session: null, slides: null, model: OCR.model, ollama: OCR.ollamaUrl, again: false, sources: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === '--session') options.session = value;
    else if (argv[index] === '--slides') options.slides = value;
    else if (argv[index] === '--model') options.model = value;
    else if (argv[index] === '--ollama') options.ollama = value.replace(/\/+$/, '');
    else if (argv[index] === '--source') options.sources.push(value);
    else if (argv[index] === '--again') {
      options.again = true;
      continue;
    } else throw new Error(`Unknown option ${argv[index]}`);
    index += 1;
  }
  return options;
}

// The text on one picture.
export async function readText(file, { ollama = OCR.ollamaUrl, model = OCR.model, prompt = OCR.prompt } = {}) {
  const response = await fetch(`${ollama}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, images: [fs.readFileSync(file).toString('base64')], stream: false }),
    signal: AbortSignal.timeout(300000)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Ollama: ${value.error || response.status}`);
  return String(value.response || '').trim();
}

export async function ocrSlides(slidesDir, { model, ollama, again = false, log = console.log } = {}) {
  const indexPath = path.join(slidesDir, 'slides.json');
  if (!fs.existsSync(indexPath)) throw new Error(`No slides.json in ${slidesDir} (run extract-slides first)`);
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const todo = (index.slides || []).filter((slide) => again || typeof slide.text !== 'string');
  log(`${todo.length} of ${(index.slides || []).length} slides to read with ${model}`);
  let read = 0;
  for (const slide of todo) {
    const file = path.join(slidesDir, slide.fileName);
    if (!fs.existsSync(file)) continue;
    const started = Date.now();
    slide.text = await readText(file, { ollama, model });
    slide.textModel = model;
    read += 1;
    // Saved as it goes (the file read again first, in case extract-slides added slides meanwhile).
    const latest = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    for (const item of latest.slides || [])
      if (item.fileName === slide.fileName) Object.assign(item, { text: slide.text, textModel: model });
    await writeJsonAtomically(indexPath, latest);
    log(
      `  ${slide.fileName}: ${slide.text.split('\n')[0].slice(0, 70)} (${Math.round((Date.now() - started) / 1000)}s)`
    );
  }
  return read;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const slidesDir = options.slides
    ? path.resolve(options.slides)
    : path.join(options.session ? path.resolve(options.session) : await findLatestSession(options.sources), 'slides');
  const read = await ocrSlides(slidesDir, options);
  console.log(`Read the text on ${read} slide${read === 1 ? '' : 's'}`);
}

export const run = () =>
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
