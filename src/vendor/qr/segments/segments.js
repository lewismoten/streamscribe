import { BitBuffer } from '../bit-buffer.js';
import { getCountBitLength, getDataCodewords } from '../capacity.js';
import { MODE_BITS } from '../constants.js';
import { createQrError } from '../error.js';
import {
  assertContentLength,
  assertSegmentCount,
} from '../input-validation.js';
import { makeSegment } from './segment.js';
import { optimizeSegments } from './segment-optimizer.js';

export { optimizeSegments } from './segment-optimizer.js';

const MODE_INDICATOR_BITS = 4;
const BITS_PER_CODEWORD = 8;
const MINIMUM_VERSION = 1;
const MAXIMUM_VERSION = 40;
const SMALL_VERSION_MAXIMUM = 9;
const MEDIUM_VERSION_MAXIMUM = 26;
const MEDIUM_VERSION_START = 10;
const LARGE_VERSION_START = 27;
const MAXIMUM_TERMINATOR_BITS = 4;
const FIRST_PAD_CODEWORD = 0xec;
const SECOND_PAD_CODEWORD = 0x11;
const ALIGNMENT_BIT = 0;

function normalizeSegments(payload) {
  assertSegmentCount(payload.length);
  let totalLength = 0;
  return payload.map((part) => {
    const data = String(part.data);
    totalLength += data.length;
    assertContentLength(totalLength);
    return makeSegment(
      data,
      typeof part.mode === 'string' ? part.mode : part.mode?.id,
    );
  });
}

function getRequiredBits(segments, version) {
  let total = 0;
  for (const segment of segments) {
    const countBits = getCountBitLength(segment.mode, version);
    if (segment.characterCount >= 2 ** countBits) return Infinity;
    total += MODE_INDICATOR_BITS + countBits + segment.bits.length;
  }
  return total;
}

function chooseVersion(segments, errorLevel, requestedVersion) {
  const fits = (version) =>
    getRequiredBits(segments, version) <=
    getDataCodewords(version, errorLevel) * BITS_PER_CODEWORD;
  if (requestedVersion !== undefined) {
    if (
      !Number.isInteger(requestedVersion) ||
      requestedVersion < MINIMUM_VERSION ||
      requestedVersion > MAXIMUM_VERSION
    ) {
      throw createQrError(
        'versionRange',
        'QR version must be an integer from {minimum} through {maximum}.',
        { minimum: MINIMUM_VERSION, maximum: MAXIMUM_VERSION },
        RangeError,
      );
    }
    if (fits(requestedVersion)) return requestedVersion;
  }
  for (
    let version = MINIMUM_VERSION;
    version <= MAXIMUM_VERSION;
    version += 1
  ) {
    if (fits(version)) {
      if (requestedVersion !== undefined) {
        throw createQrError(
          'minimumVersion',
          'The chosen QR Code version cannot contain this amount of data. Minimum version required is: {version}.',
          { version },
        );
      }
      return version;
    }
  }
  throw createQrError(
    'tooLarge',
    'The content is too large for a version {maximum} QR Code.',
    { maximum: MAXIMUM_VERSION },
  );
}

export function selectVersionAndSegments(
  payload,
  errorLevel,
  requestedVersion,
) {
  if (Array.isArray(payload)) {
    const segments = normalizeSegments(payload);
    return {
      segments,
      version: chooseVersion(segments, errorLevel, requestedVersion),
    };
  }

  const text = String(payload);
  assertContentLength(text.length);
  const optimizedByBucket = new Map();
  const getOptimized = (version) => {
    const bucketVersion =
      version <= SMALL_VERSION_MAXIMUM
        ? MINIMUM_VERSION
        : version <= MEDIUM_VERSION_MAXIMUM
          ? MEDIUM_VERSION_START
          : LARGE_VERSION_START;
    if (!optimizedByBucket.has(bucketVersion))
      optimizedByBucket.set(
        bucketVersion,
        optimizeSegments(text, bucketVersion),
      );
    return optimizedByBucket.get(bucketVersion);
  };
  const fits = (version, segments) =>
    getRequiredBits(segments, version) <=
    getDataCodewords(version, errorLevel) * BITS_PER_CODEWORD;

  if (requestedVersion !== undefined) {
    if (
      !Number.isInteger(requestedVersion) ||
      requestedVersion < MINIMUM_VERSION ||
      requestedVersion > MAXIMUM_VERSION
    ) {
      throw createQrError(
        'versionRange',
        'QR version must be an integer from {minimum} through {maximum}.',
        { minimum: MINIMUM_VERSION, maximum: MAXIMUM_VERSION },
        RangeError,
      );
    }
    const requestedSegments = getOptimized(requestedVersion);
    if (fits(requestedVersion, requestedSegments))
      return { segments: requestedSegments, version: requestedVersion };
  }

  for (
    let version = MINIMUM_VERSION;
    version <= MAXIMUM_VERSION;
    version += 1
  ) {
    const segments = getOptimized(version);
    if (!fits(version, segments)) continue;
    if (requestedVersion !== undefined) {
      throw createQrError(
        'minimumVersion',
        'The chosen QR Code version cannot contain this amount of data. Minimum version required is: {version}.',
        { version },
      );
    }
    return { segments, version };
  }
  throw createQrError(
    'tooLarge',
    'The content is too large for a version {maximum} QR Code.',
    { maximum: MAXIMUM_VERSION },
  );
}

export function makeDataCodewords(segments, version, errorLevel) {
  const capacity = getDataCodewords(version, errorLevel) * BITS_PER_CODEWORD;
  const buffer = new BitBuffer();
  segments.forEach((segment) => {
    buffer.append(MODE_BITS[segment.mode], MODE_INDICATOR_BITS);
    buffer.append(
      segment.characterCount,
      getCountBitLength(segment.mode, version),
    );
    buffer.bits.push(...segment.bits);
  });
  buffer.append(
    0,
    Math.min(MAXIMUM_TERMINATOR_BITS, capacity - buffer.bits.length),
  );
  while (buffer.bits.length % BITS_PER_CODEWORD) {
    buffer.bits.push(ALIGNMENT_BIT);
  }
  for (
    let pad = FIRST_PAD_CODEWORD;
    buffer.bits.length < capacity;
    pad ^= FIRST_PAD_CODEWORD ^ SECOND_PAD_CODEWORD
  ) {
    buffer.append(pad, BITS_PER_CODEWORD);
  }

  const result = new Array(buffer.bits.length / BITS_PER_CODEWORD);
  for (let byte = 0; byte < result.length; byte += 1) {
    const offset = byte * BITS_PER_CODEWORD;
    let value = 0;
    for (let bit = 0; bit < BITS_PER_CODEWORD; bit += 1)
      value = (value << 1) | buffer.bits[offset + bit];
    result[byte] = value;
  }
  return result;
}
