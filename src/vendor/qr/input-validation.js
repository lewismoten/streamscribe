import { getDataCodewords } from './capacity.js';
import { createQrError } from './error.js';

const MAX_CONTENT_CHARACTERS = 7089;
const MAXIMUM_VERSION = 40;
const BITS_PER_CODEWORD = 8;
const MINIMUM_SEGMENT_OVERHEAD_BITS = 12;
const MINIMUM_VERSION = 1;
const MAX_SEGMENTS = Math.floor(
  (getDataCodewords(MAXIMUM_VERSION, 'L') * BITS_PER_CODEWORD) /
    MINIMUM_SEGMENT_OVERHEAD_BITS,
);

export function assertContentLength(length) {
  if (length > MAX_CONTENT_CHARACTERS)
    throw createQrError(
      'contentTooLong',
      'Content exceeds the QR input limit of {maximum} characters.',
      { maximum: MAX_CONTENT_CHARACTERS },
    );
}

export function assertSegmentCount(count) {
  if (count > MAX_SEGMENTS)
    throw createQrError(
      'tooManySegments',
      'The segment list exceeds the safe QR input limit of {maximum}.',
      { maximum: MAX_SEGMENTS },
    );
}

export function assertVersion(version) {
  if (
    !Number.isInteger(version) ||
    version < MINIMUM_VERSION ||
    version > MAXIMUM_VERSION
  )
    throw createQrError(
      'versionRange',
      'QR version must be an integer from {minimum} through {maximum}.',
      { minimum: MINIMUM_VERSION, maximum: MAXIMUM_VERSION },
      RangeError,
    );
}

export function getOwnOption(options, name, fallback) {
  return Object.hasOwn(options, name) ? options[name] : fallback;
}
