import { createQrError } from './error.js';

const MAXIMUM_BITWISE_VALUE_LENGTH = 31;

export class BitBuffer {
  constructor() {
    this.bits = [];
  }

  append(value, length) {
    if (
      length < 0 ||
      length > MAXIMUM_BITWISE_VALUE_LENGTH ||
      value >>> length !== 0
    ) {
      throw createQrError(
        'bitLength',
        'A value does not fit in the requested QR bit length.',
        undefined,
        RangeError,
      );
    }
    for (let index = length - 1; index >= 0; index -= 1) {
      this.bits.push((value >>> index) & 1);
    }
  }
}
