const maskMaps = new Map();
const MASK_PATTERN_COUNT = 8;
const MASK_THREE = 3;
const MASK_FOUR = 4;
const MASK_FIVE = 5;
const MASK_SIX = 6;
const MASK_SEVEN = 7;
const MASK_THREE_DIVISOR = 3;

export function isMaskActive(mask, row, column) {
  switch (mask) {
    case 0:
      return (row + column) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return column % MASK_THREE_DIVISOR === 0;
    case MASK_THREE:
      return (row + column) % MASK_THREE_DIVISOR === 0;
    case MASK_FOUR:
      return (
        (Math.floor(row / 2) + Math.floor(column / MASK_THREE_DIVISOR)) % 2 ===
        0
      );
    case MASK_FIVE:
      return ((row * column) % 2) + ((row * column) % MASK_THREE_DIVISOR) === 0;
    case MASK_SIX:
      return (
        (((row * column) % 2) + ((row * column) % MASK_THREE_DIVISOR)) % 2 === 0
      );
    case MASK_SEVEN:
      return (
        (((row + column) % 2) + ((row * column) % MASK_THREE_DIVISOR)) % 2 === 0
      );
    default:
      return false;
  }
}

export function getMaskMap(size, mask) {
  const key = size * MASK_PATTERN_COUNT + mask;
  const cached = maskMaps.get(key);
  if (cached) return cached;
  const result = new Uint8Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      result[row * size + column] = isMaskActive(mask, row, column) ? 1 : 0;
    }
  }
  maskMaps.set(key, result);
  return result;
}
