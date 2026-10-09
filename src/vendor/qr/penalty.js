const workspaces = new Map();
const MINIMUM_PENALIZED_RUN = 5;
const RUN_BASELINE = 2;
const FINDER_PATTERN_WINDOW_BITS = 11;
const FINDER_PATTERN_WINDOW_MASK = 0x7ff;
const FINDER_PATTERN_FORWARD = 0x05d;
const FINDER_PATTERN_REVERSE = 0x5d0;
const FINDER_PATTERN_END = FINDER_PATTERN_WINDOW_BITS - 1;
const FINDER_PATTERN_PENALTY = 40;
const BLOCK_PENALTY = 3;
const PERCENTAGE_SCALE = 100;
const IDEAL_DARK_PERCENTAGE = 50;
const DARK_PERCENTAGE_STEP = 5;
const DARK_PERCENTAGE_PENALTY = 10;

function getWorkspace(size) {
  if (!workspaces.has(size)) {
    workspaces.set(size, {
      patterns: new Uint16Array(size),
      runs: new Uint16Array(size),
    });
  }
  return workspaces.get(size);
}

export function getPenalty(modules) {
  const size = modules.length;
  const workspace = getWorkspace(size);
  const columnPatterns = workspace.patterns;
  const columnRuns = workspace.runs;
  let result = 0;
  let darkCount = 0;

  for (let row = 0; row < size; row += 1) {
    const currentRow = modules[row];
    const previousRow = modules[row - 1];
    let rowPattern = currentRow[0];
    let rowRun = 1;

    for (let column = 0; column < size; column += 1) {
      const dark = currentRow[column];
      if (dark) darkCount += 1;

      if (column > 0) {
        if (dark === currentRow[column - 1]) rowRun += 1;
        else {
          if (rowRun >= MINIMUM_PENALIZED_RUN) {
            result += rowRun - RUN_BASELINE;
          }
          rowRun = 1;
        }
        rowPattern = ((rowPattern << 1) | dark) & FINDER_PATTERN_WINDOW_MASK;
        if (
          column >= FINDER_PATTERN_END &&
          (rowPattern === FINDER_PATTERN_FORWARD ||
            rowPattern === FINDER_PATTERN_REVERSE)
        ) {
          result += FINDER_PATTERN_PENALTY;
        }
      }

      if (row === 0) {
        columnPatterns[column] = dark;
        columnRuns[column] = 1;
      } else {
        if (dark === previousRow[column]) columnRuns[column] += 1;
        else {
          if (columnRuns[column] >= MINIMUM_PENALIZED_RUN) {
            result += columnRuns[column] - RUN_BASELINE;
          }
          columnRuns[column] = 1;
        }
        const pattern =
          ((columnPatterns[column] << 1) | dark) & FINDER_PATTERN_WINDOW_MASK;
        columnPatterns[column] = pattern;
        if (
          row >= FINDER_PATTERN_END &&
          (pattern === FINDER_PATTERN_FORWARD ||
            pattern === FINDER_PATTERN_REVERSE)
        ) {
          result += FINDER_PATTERN_PENALTY;
        }

        if (
          column > 0 &&
          dark === currentRow[column - 1] &&
          dark === previousRow[column] &&
          dark === previousRow[column - 1]
        )
          result += BLOCK_PENALTY;
      }
    }
    if (rowRun >= MINIMUM_PENALIZED_RUN) result += rowRun - RUN_BASELINE;
  }

  for (let column = 0; column < size; column += 1) {
    if (columnRuns[column] >= MINIMUM_PENALIZED_RUN) {
      result += columnRuns[column] - RUN_BASELINE;
    }
  }
  const darkPercentage = (darkCount * PERCENTAGE_SCALE) / (size * size);
  result +=
    Math.floor(
      Math.abs(darkPercentage - IDEAL_DARK_PERCENTAGE) / DARK_PERCENTAGE_STEP,
    ) * DARK_PERCENTAGE_PENALTY;
  return result;
}
