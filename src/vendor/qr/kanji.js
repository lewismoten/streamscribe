import { createQrError } from './error.js';

let shiftJisMap;

const FIRST_LEAD_RANGE_START = 0x81;
const FIRST_LEAD_RANGE_END = 0x9f;
const SECOND_LEAD_RANGE_START = 0xe0;
const SECOND_LEAD_RANGE_END = 0xeb;
const TRAIL_RANGE_START = 0x40;
const TRAIL_RANGE_END = 0xfc;
const INVALID_TRAIL_BYTE = 0x7f;
const BITS_PER_BYTE = 8;
const FIRST_QR_RANGE_START = 0x8140;
const FIRST_QR_RANGE_END = 0x9ffc;
const SECOND_QR_RANGE_START = 0xe040;
const SECOND_QR_RANGE_END = 0xebbf;
const SECOND_QR_RANGE_OFFSET = 0xc140;
const QR_KANJI_ROW_WIDTH = 0xc0;
const BYTE_MASK = 0xff;

export function buildShiftJisMap(decoder) {
  const result = new Map();
  const leadRanges = [
    [FIRST_LEAD_RANGE_START, FIRST_LEAD_RANGE_END],
    [SECOND_LEAD_RANGE_START, SECOND_LEAD_RANGE_END],
  ];
  leadRanges.forEach(([firstLead, lastLead]) => {
    for (let lead = firstLead; lead <= lastLead; lead += 1) {
      for (
        let trail = TRAIL_RANGE_START;
        trail <= TRAIL_RANGE_END;
        trail += 1
      ) {
        if (trail === INVALID_TRAIL_BYTE) continue;
        try {
          const character = decoder.decode(Uint8Array.of(lead, trail));
          if (
            [...character].length === 1 &&
            character !== '\ufffd' &&
            !result.has(character)
          ) {
            result.set(character, (lead << BITS_PER_BYTE) | trail);
          }
        } catch {
          // Unassigned Shift JIS byte pairs are not QR Kanji characters.
        }
      }
    }
  });
  return result;
}

function getShiftJisMap() {
  if (shiftJisMap) return shiftJisMap;
  let decoder;
  try {
    decoder = new TextDecoder('shift_jis', { fatal: true });
  } catch {
    throw createQrError(
      'kanjiUnsupported',
      'Native Kanji mode requires browser Shift JIS decoding support.',
    );
  }

  shiftJisMap = buildShiftJisMap(decoder);
  return shiftJisMap;
}

export function toShiftJis(character) {
  return getShiftJisMap().get(character);
}

export function getQrKanjiValueFromShiftJis(shiftJis) {
  if (!Number.isInteger(shiftJis)) return null;
  let adjusted;
  if (shiftJis >= FIRST_QR_RANGE_START && shiftJis <= FIRST_QR_RANGE_END) {
    adjusted = shiftJis - FIRST_QR_RANGE_START;
  } else if (
    shiftJis >= SECOND_QR_RANGE_START &&
    shiftJis <= SECOND_QR_RANGE_END
  ) {
    adjusted = shiftJis - SECOND_QR_RANGE_OFFSET;
  } else return null;
  return (
    (adjusted >>> BITS_PER_BYTE) * QR_KANJI_ROW_WIDTH + (adjusted & BYTE_MASK)
  );
}

export function getQrKanjiValue(character) {
  return getQrKanjiValueFromShiftJis(toShiftJis(character));
}
