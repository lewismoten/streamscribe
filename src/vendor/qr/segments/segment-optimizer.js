import { getCountBitLength } from '../capacity.js';
import { ALPHANUMERIC } from '../constants.js';
import { makeSegment } from './segment.js';

const NUMERIC_MODES = ['numeric', 'alphanumeric', 'byte'];
const ALPHANUMERIC_MODES = ['alphanumeric', 'byte'];
const BYTE_MODES = ['byte'];
const ASCII_DIGIT_START = 0x30;
const ASCII_DIGIT_END = 0x39;
const SINGLE_BYTE_MAXIMUM = 0x7f;
const TWO_BYTE_MAXIMUM = 0x7ff;
const THREE_BYTE_MAXIMUM = 0xffff;
const THREE_BYTE_UNITS = 3;
const FOUR_BYTE_UNITS = 4;
const NUMERIC_GROUP_UNITS = 3;
const NUMERIC_GROUP_START_BITS = 4;
const NUMERIC_CONTINUATION_BITS = 3;
const ALPHANUMERIC_GROUP_UNITS = 2;
const ALPHANUMERIC_GROUP_START_BITS = 6;
const ALPHANUMERIC_CONTINUATION_BITS = 5;
const BITS_PER_BYTE = 8;
const MODE_INDICATOR_BITS = 4;
const NUMERIC_STATE_COUNT = 3;
const ALPHANUMERIC_STATE_OFFSET = NUMERIC_STATE_COUNT;
const BYTE_STATE_INDEX = 5;
const OPTIMIZATION_STATE_COUNT = 6;

function getCharacterModes(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint >= ASCII_DIGIT_START && codePoint <= ASCII_DIGIT_END) {
    return NUMERIC_MODES;
  }
  if (ALPHANUMERIC.includes(character)) return ALPHANUMERIC_MODES;
  return BYTE_MODES;
}

function getModeUnitCount(mode, character) {
  if (mode !== 'byte') return 1;
  const codePoint = character.codePointAt(0);
  if (codePoint <= SINGLE_BYTE_MAXIMUM) return 1;
  if (codePoint <= TWO_BYTE_MAXIMUM) return 2;
  if (codePoint <= THREE_BYTE_MAXIMUM) return THREE_BYTE_UNITS;
  return FOUR_BYTE_UNITS;
}

function getIncrementalPayloadBits(mode, previousCount, unitCount) {
  if (mode === 'numeric') {
    return previousCount % NUMERIC_GROUP_UNITS === 0
      ? NUMERIC_GROUP_START_BITS
      : NUMERIC_CONTINUATION_BITS;
  }
  if (mode === 'alphanumeric') {
    return previousCount % ALPHANUMERIC_GROUP_UNITS === 0
      ? ALPHANUMERIC_GROUP_START_BITS
      : ALPHANUMERIC_CONTINUATION_BITS;
  }
  return unitCount * BITS_PER_BYTE;
}

function getOptimizationIndex(mode, count) {
  if (mode === 'numeric') return count % NUMERIC_STATE_COUNT;
  if (mode === 'alphanumeric') {
    return ALPHANUMERIC_STATE_OFFSET + (count % ALPHANUMERIC_GROUP_UNITS);
  }
  return BYTE_STATE_INDEX;
}

function addCandidate(
  states,
  previous,
  character,
  mode,
  unitCount,
  countBits,
  continuing,
) {
  const previousCount = continuing ? previous.segmentCount : 0;
  const segmentCount = previousCount + unitCount;
  const cost =
    (previous ? previous.cost : 0) +
    (continuing ? 0 : MODE_INDICATOR_BITS + countBits) +
    getIncrementalPayloadBits(mode, previousCount, unitCount);
  const index = getOptimizationIndex(mode, segmentCount);
  const existing = states[index];
  const prefersSpecializedBoundary =
    existing &&
    cost === existing.cost &&
    !continuing &&
    !existing.startsSegment;
  if (existing && cost > existing.cost) return;
  if (existing && cost === existing.cost && !prefersSpecializedBoundary) return;
  states[index] = {
    cost,
    mode,
    segmentCount,
    character,
    startsSegment: !continuing,
    previous,
  };
}

export function optimizeSegments(text, version) {
  const characters = [...String(text)];
  if (!characters.length) return [makeSegment('', 'byte')];
  let states = [];

  for (const character of characters) {
    const nextStates = new Array(OPTIMIZATION_STATE_COUNT);
    const availableModes = getCharacterModes(character);
    const previousStates = states.length ? states : [null];
    for (const previous of previousStates) {
      for (const mode of availableModes) {
        const unitCount = getModeUnitCount(mode, character);
        const countBits = getCountBitLength(mode, version);
        const maximumCount = 2 ** countBits - 1;
        addCandidate(
          nextStates,
          previous,
          character,
          mode,
          unitCount,
          countBits,
          false,
        );
        if (
          previous &&
          previous.mode === mode &&
          previous.segmentCount + unitCount <= maximumCount
        )
          addCandidate(
            nextStates,
            previous,
            character,
            mode,
            unitCount,
            countBits,
            true,
          );
      }
    }
    states = [];
    for (const state of nextStates) {
      if (state) states.push(state);
    }
  }

  let current = states.reduce(
    (best, state) => (!best || state.cost < best.cost ? state : best),
    null,
  );
  const encodedCharacters = [];
  while (current) {
    encodedCharacters.push(current);
    current = current.previous;
  }
  encodedCharacters.reverse();

  const optimized = [];
  encodedCharacters.forEach(({ character, mode, startsSegment }) => {
    if (startsSegment || !optimized.length) {
      optimized.push({ mode, data: character });
    } else {
      optimized.at(-1).data += character;
    }
  });
  return optimized.map(({ data, mode }) => makeSegment(data, mode));
}
