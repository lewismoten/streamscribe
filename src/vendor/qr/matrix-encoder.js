import { getDataCodewords, getRawDataModules } from './capacity.js';
import { FORMAT_ECL_BITS } from './constants.js';
import { createQrError } from './error.js';
import { assertVersion, getOwnOption } from './input-validation.js';
import {
  addErrorCorrection,
  getReedSolomonRemainder,
  makeReedSolomonDivisor,
} from './reed-solomon.js';
import { toShiftJis } from './kanji.js';
import { getMaskMap } from './mask.js';
import {
  drawAlignment,
  drawFinder,
  getAlignmentPositions,
} from './matrix/patterns.js';
import * as M from './matrix/specification.js';
import { getPenalty } from './penalty.js';
import {
  makeDataCodewords,
  optimizeSegments,
  selectVersionAndSegments,
} from './segments/segments.js';

class MatrixBuilder {
  constructor(version, errorLevel, codewords) {
    assertVersion(version);
    this.version = version;
    this.errorLevel = errorLevel;
    this.size = version * M.modulesPerVersion + M.versionOneSize;
    this.modules = Array.from(
      { length: this.size },
      () => new Uint8Array(this.size),
    );
    this.functionModules = Array.from(
      { length: this.size },
      () => new Uint8Array(this.size),
    );
    this.drawFunctionPatterns();
    this.drawCodewords(codewords);
  }

  prepareMaskableColumns() {
    this.maskableColumns = this.functionModules.map((row) => {
      const columns = [];
      for (let column = 0; column < row.length; column += 1) {
        if (!row[column]) columns.push(column);
      }
      return Uint8Array.from(columns);
    });
  }

  setFunction(row, column, dark) {
    this.modules[row][column] = dark ? 1 : 0;
    this.functionModules[row][column] = 1;
  }

  drawFunctionPatterns() {
    for (let index = 0; index < this.size; index += 1) {
      this.setFunction(M.timingAxis, index, index % 2 === 0);
      this.setFunction(index, M.timingAxis, index % 2 === 0);
    }
    drawFinder(this, M.finderCenterOffset, M.finderCenterOffset);
    drawFinder(this, M.finderCenterOffset, this.size - M.finderFarEdgeOffset);
    drawFinder(this, this.size - M.finderFarEdgeOffset, M.finderCenterOffset);

    const positions = getAlignmentPositions(this.version);
    positions.forEach((row, rowIndex) =>
      positions.forEach((column, columnIndex) => {
        const last = positions.length - 1;
        const overlapsFinder =
          (rowIndex === 0 && columnIndex === 0) ||
          (rowIndex === 0 && columnIndex === last) ||
          (rowIndex === last && columnIndex === 0);
        if (!overlapsFinder) drawAlignment(this, row, column);
      }),
    );
    this.drawFormatBits(0);
    this.drawVersionBits();
  }

  drawFormatBits(mask) {
    const data =
      (FORMAT_ECL_BITS[this.errorLevel] << M.formatErrorLevelShift) | mask;
    let remainder = data;
    for (let index = 0; index < M.formatGeneratorDegree; index += 1) {
      remainder =
        (remainder << 1) ^
        ((remainder >>> M.formatRemainderHighBit) * M.formatGenerator);
    }
    const bits = ((data << M.formatDataShift) | remainder) ^ M.formatMask;
    const bit = (index) => ((bits >>> index) & 1) !== 0;

    for (let index = 0; index <= M.formatFirstSequenceEnd; index += 1) {
      this.setFunction(index, M.formatAxis, bit(index));
    }
    this.setFunction(M.maximumMaskPattern, M.formatAxis, bit(M.timingAxis));
    this.setFunction(M.formatAxis, M.formatAxis, bit(M.maximumMaskPattern));
    this.setFunction(M.formatAxis, M.maximumMaskPattern, bit(M.formatAxis));
    for (
      let index = M.formatSecondSequenceStart;
      index < M.formatSequenceBits;
      index += 1
    ) {
      this.setFunction(
        M.formatAxis,
        M.formatSequenceBits - 1 - index,
        bit(index),
      );
    }
    for (let index = 0; index < M.formatAxis; index += 1) {
      this.setFunction(M.formatAxis, this.size - 1 - index, bit(index));
    }
    for (let index = M.formatAxis; index < M.formatSequenceBits; index += 1) {
      this.setFunction(
        this.size - M.formatSequenceBits + index,
        M.formatAxis,
        bit(index),
      );
    }
    this.setFunction(this.size - M.formatAxis, M.formatAxis, true);
  }

  drawVersionBits() {
    if (this.version < M.versionInformationStart) return;
    let remainder = this.version;
    for (let index = 0; index < M.versionGeneratorDegree; index += 1) {
      remainder =
        (remainder << 1) ^
        ((remainder >>> M.versionInformationEdgeOffset) * M.versionGenerator);
    }
    const bits = (this.version << M.versionDataShift) | remainder;
    for (let index = 0; index < M.versionInformationBits; index += 1) {
      const dark = ((bits >>> index) & 1) !== 0;
      const low = Math.floor(index / M.versionInformationColumns);
      const high =
        this.size -
        M.versionInformationEdgeOffset +
        (index % M.versionInformationColumns);
      this.setFunction(low, high, dark);
      this.setFunction(high, low, dark);
    }
  }

  drawCodewords(codewords) {
    let bitIndex = 0;
    for (let right = this.size - 1; right >= 1; right -= M.dataColumnStep) {
      if (right === M.timingAxis) right = M.timingDataColumn;
      for (let vertical = 0; vertical < this.size; vertical += 1) {
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? this.size - 1 - vertical : vertical;
        for (let pair = 0; pair < M.dataColumnStep; pair += 1) {
          const column = right - pair;
          if (
            this.functionModules[row][column] ||
            bitIndex >= codewords.length * M.bitsPerCodeword
          )
            continue;
          this.modules[row][column] =
            (codewords[bitIndex >>> M.codewordIndexShift] >>>
              (M.maximumMaskPattern - (bitIndex & M.maximumMaskPattern))) &
            1;
          bitIndex += 1;
        }
      }
    }
    if (bitIndex !== codewords.length * M.bitsPerCodeword)
      throw createQrError(
        'matrixBits',
        'The QR matrix could not place every encoded bit.',
      );
  }

  transitionMask(previousMask, nextMask) {
    const previous =
      previousMask === undefined ? null : getMaskMap(this.size, previousMask);
    const next = getMaskMap(this.size, nextMask);
    if (!this.maskableColumns) {
      for (let row = 0; row < this.size; row += 1) {
        const modules = this.modules[row];
        const functions = this.functionModules[row];
        const offset = row * this.size;
        for (let column = 0; column < this.size; column += 1) {
          if (!functions[column] && next[offset + column]) modules[column] ^= 1;
        }
      }
      return;
    }
    for (let row = 0; row < this.size; row += 1) {
      const columns = this.maskableColumns[row];
      const modules = this.modules[row];
      const offset = row * this.size;
      if (previous === null) {
        for (let item = 0; item < columns.length; item += 1) {
          const column = columns[item];
          if (next[offset + column]) modules[column] ^= 1;
        }
      } else {
        for (let item = 0; item < columns.length; item += 1) {
          const column = columns[item];
          const index = offset + column;
          if (previous[index] !== next[index]) modules[column] ^= 1;
        }
      }
    }
  }

  finish(requestedMask) {
    let mask = requestedMask;
    let appliedMask;
    if (mask === undefined) {
      this.prepareMaskableColumns();
      let minimumPenalty = Infinity;
      for (let candidate = 0; candidate < M.maskPatternCount; candidate += 1) {
        this.transitionMask(appliedMask, candidate);
        appliedMask = candidate;
        this.drawFormatBits(candidate);
        const penalty = getPenalty(this.modules);
        if (penalty < minimumPenalty) {
          mask = candidate;
          minimumPenalty = penalty;
        }
      }
    }
    if (
      !Number.isInteger(mask) ||
      mask < M.minimumMaskPattern ||
      mask > M.maximumMaskPattern
    )
      throw createQrError(
        'maskPattern',
        'Mask pattern must be an integer from {minimum} through {maximum}.',
        {
          minimum: M.minimumMaskPattern,
          maximum: M.maximumMaskPattern,
        },
        RangeError,
      );
    this.transitionMask(appliedMask, mask);
    this.drawFormatBits(mask);
    return mask;
  }
}

function create(payload, options = {}) {
  const settings = options ?? {};
  const errorLevel = String(
    getOwnOption(settings, 'errorCorrectionLevel', 'M') || 'M',
  ).toUpperCase();
  if (!Object.hasOwn(FORMAT_ECL_BITS, errorLevel))
    throw createQrError(
      'errorCorrectionLevel',
      'Unknown QR error correction level: {level}.',
      { level: errorLevel },
    );
  const { segments, version } = selectVersionAndSegments(
    payload,
    errorLevel,
    getOwnOption(settings, 'version'),
  );
  const data = makeDataCodewords(segments, version, errorLevel);
  const codewords = addErrorCorrection(data, version, errorLevel);
  const builder = new MatrixBuilder(version, errorLevel, codewords);
  const maskPattern = builder.finish(getOwnOption(settings, 'maskPattern'));
  const flatModules = new Uint8Array(builder.size * builder.size);
  let moduleIndex = 0;
  for (const row of builder.modules) {
    flatModules.set(row, moduleIndex);
    moduleIndex += builder.size;
  }

  return {
    version,
    errorCorrectionLevel: errorLevel,
    maskPattern,
    segments,
    modules: {
      size: builder.size,
      data: flatModules,
      get(row, column) {
        return Boolean(flatModules[row * builder.size + column]);
      },
    },
  };
}

export default {
  create,
  toSJIS: toShiftJis,
  internals: {
    MatrixBuilder,
    getDataCodewords,
    getRawDataModules,
    makeReedSolomonDivisor,
    getReedSolomonRemainder,
    optimizeSegments,
  },
};
export { create, toShiftJis as toSJIS };
