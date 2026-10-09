import * as M from './specification.js';

export function getAlignmentPositions(version) {
  if (version === 1) return [];
  const size = version * M.modulesPerVersion + M.versionOneSize;
  const count = Math.floor(version / M.alignmentVersionDivisor) + 2;
  const step =
    version === M.alignmentSpecialVersion
      ? M.alignmentSpecialStep
      : Math.ceil(
          (size - M.alignmentEdgeSpan) /
            (count * M.dataColumnStep - M.dataColumnStep),
        ) * M.dataColumnStep;
  const result = [M.alignmentFirstCenter];
  for (
    let position = size - M.alignmentFarEdgeOffset;
    result.length < count;
    position -= step
  ) {
    result.splice(1, 0, position);
  }
  return result;
}

export function drawFinder(builder, centerRow, centerColumn) {
  for (
    let rowOffset = -M.finderRadius;
    rowOffset <= M.finderRadius;
    rowOffset += 1
  ) {
    for (
      let columnOffset = -M.finderRadius;
      columnOffset <= M.finderRadius;
      columnOffset += 1
    ) {
      const row = centerRow + rowOffset;
      const column = centerColumn + columnOffset;
      if (
        row < 0 ||
        row >= builder.size ||
        column < 0 ||
        column >= builder.size
      )
        continue;
      const distance = Math.max(Math.abs(rowOffset), Math.abs(columnOffset));
      builder.setFunction(
        row,
        column,
        distance !== M.finderWhiteRadius && distance !== M.finderRadius,
      );
    }
  }
}

export function drawAlignment(builder, centerRow, centerColumn) {
  for (
    let rowOffset = -M.alignmentRadius;
    rowOffset <= M.alignmentRadius;
    rowOffset += 1
  ) {
    for (
      let columnOffset = -M.alignmentRadius;
      columnOffset <= M.alignmentRadius;
      columnOffset += 1
    ) {
      builder.setFunction(
        centerRow + rowOffset,
        centerColumn + columnOffset,
        Math.max(Math.abs(rowOffset), Math.abs(columnOffset)) !==
          M.alignmentWhiteRadius,
      );
    }
  }
}
