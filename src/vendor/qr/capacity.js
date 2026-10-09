import {
  COUNT_BITS,
  ECC_CODEWORDS_PER_BLOCK,
  NUM_ERROR_CORRECTION_BLOCKS,
} from './constants.js';

const SMALL_VERSION_MAXIMUM = 9;
const MEDIUM_VERSION_MAXIMUM = 26;
const SMALL_COUNT_WIDTH_INDEX = 0;
const MEDIUM_COUNT_WIDTH_INDEX = 1;
const LARGE_COUNT_WIDTH_INDEX = 2;
const RAW_MODULE_LINEAR_FACTOR = 16;
const RAW_MODULE_BASE = 128;
const RAW_MODULE_CONSTANT = 64;
const ALIGNMENT_VERSION_START = 2;
const ALIGNMENT_VERSION_DIVISOR = 7;
const ALIGNMENT_PATTERN_BASE_COUNT = 2;
const ALIGNMENT_MODULE_FACTOR = 25;
const ALIGNMENT_EDGE_OVERLAP = 10;
const ALIGNMENT_CORRECTION = 55;
const VERSION_INFORMATION_START = 7;
const VERSION_INFORMATION_MODULES = 36;
const BITS_PER_CODEWORD = 8;

export function getCountBitLength(mode, version) {
  const widthIndex =
    version <= SMALL_VERSION_MAXIMUM
      ? SMALL_COUNT_WIDTH_INDEX
      : version <= MEDIUM_VERSION_MAXIMUM
        ? MEDIUM_COUNT_WIDTH_INDEX
        : LARGE_COUNT_WIDTH_INDEX;
  return COUNT_BITS[mode][widthIndex];
}

export function getRawDataModules(version) {
  let result =
    (RAW_MODULE_LINEAR_FACTOR * version + RAW_MODULE_BASE) * version +
    RAW_MODULE_CONSTANT;
  if (version >= ALIGNMENT_VERSION_START) {
    const align =
      Math.floor(version / ALIGNMENT_VERSION_DIVISOR) +
      ALIGNMENT_PATTERN_BASE_COUNT;
    result -=
      (ALIGNMENT_MODULE_FACTOR * align - ALIGNMENT_EDGE_OVERLAP) * align -
      ALIGNMENT_CORRECTION;
    if (version >= VERSION_INFORMATION_START) {
      result -= VERSION_INFORMATION_MODULES;
    }
  }
  return result;
}

export function getDataCodewords(version, errorLevel) {
  return (
    Math.floor(getRawDataModules(version) / BITS_PER_CODEWORD) -
    ECC_CODEWORDS_PER_BLOCK[errorLevel][version] *
      NUM_ERROR_CORRECTION_BLOCKS[errorLevel][version]
  );
}
