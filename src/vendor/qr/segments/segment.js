import { BitBuffer } from '../bit-buffer.js';
import { ALPHANUMERIC, MODE_BITS } from '../constants.js';
import { createQrError } from '../error.js';
import { getQrKanjiValue } from '../kanji.js';

const textEncoder = new TextEncoder();
const NUMERIC_GROUP_SIZE = 3;
const NUMERIC_RADIX = 10;
const NUMERIC_GROUP_BASE_BITS = 1;
const ALPHANUMERIC_RADIX = 45;
const ALPHANUMERIC_PAIR_BITS = 11;
const ALPHANUMERIC_SINGLE_BITS = 6;
const BITS_PER_BYTE = 8;
const KANJI_VALUE_BITS = 13;
const MINIMUM_NUMERIC_DIGIT = 0;
const MAXIMUM_NUMERIC_DIGIT = 9;

function detectMode(text) {
  if (/^[0-9]+$/.test(text)) return 'numeric';
  if ([...text].every((character) => ALPHANUMERIC.includes(character))) {
    return 'alphanumeric';
  }
  return 'byte';
}

export function makeSegment(data, requestedMode) {
  const text = String(data);
  const mode = requestedMode || detectMode(text);
  if (!MODE_BITS[mode]) {
    throw createQrError(
      'modeUnsupported',
      'Native QR mode is not supported yet: {mode}.',
      { mode },
    );
  }
  if (mode === 'numeric' && !/^[0-9]*$/.test(text)) {
    throw createQrError(
      'numericCharacters',
      'Numeric mode only accepts digits {minimum}-{maximum}.',
      {
        minimum: MINIMUM_NUMERIC_DIGIT,
        maximum: MAXIMUM_NUMERIC_DIGIT,
      },
    );
  }
  if (
    mode === 'alphanumeric' &&
    ![...text].every((character) => ALPHANUMERIC.includes(character))
  ) {
    throw createQrError(
      'alphanumericCharacters',
      'Alphanumeric mode contains unsupported characters.',
    );
  }
  if (
    mode === 'kanji' &&
    ![...text].every((character) => getQrKanjiValue(character) !== null)
  ) {
    throw createQrError(
      'kanjiCharacters',
      'Kanji mode contains characters outside the QR Shift JIS ranges.',
    );
  }

  const payload = new BitBuffer();
  let count;
  if (mode === 'numeric') {
    count = text.length;
    for (let index = 0; index < text.length; index += NUMERIC_GROUP_SIZE) {
      const part = text.slice(index, index + NUMERIC_GROUP_SIZE);
      payload.append(
        Number.parseInt(part, NUMERIC_RADIX),
        part.length * NUMERIC_GROUP_SIZE + NUMERIC_GROUP_BASE_BITS,
      );
    }
  } else if (mode === 'alphanumeric') {
    count = text.length;
    for (let index = 0; index + 1 < text.length; index += 2) {
      payload.append(
        ALPHANUMERIC.indexOf(text[index]) * ALPHANUMERIC_RADIX +
          ALPHANUMERIC.indexOf(text[index + 1]),
        ALPHANUMERIC_PAIR_BITS,
      );
    }
    if (text.length % 2) {
      payload.append(
        ALPHANUMERIC.indexOf(text.at(-1)),
        ALPHANUMERIC_SINGLE_BITS,
      );
    }
  } else if (mode === 'byte') {
    const bytes = textEncoder.encode(text);
    count = bytes.length;
    bytes.forEach((byte) => payload.append(byte, BITS_PER_BYTE));
  } else {
    const characters = [...text];
    count = characters.length;
    characters.forEach((character) =>
      payload.append(getQrKanjiValue(character), KANJI_VALUE_BITS),
    );
  }

  return {
    data: text,
    mode,
    characterCount: count,
    bits: payload.bits,
    getBitsLength() {
      return this.bits.length;
    },
    getLength() {
      return this.characterCount;
    },
  };
}
