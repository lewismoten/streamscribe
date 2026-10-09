// Drawing maps as SVG (build-maps.js, layered.js): projecting longitude and latitude to the page, simplifying shapes
// to a size a web page can show, paths and labels, and the page with its title and credits.
export const WIDTH = 1000;
export const escape = (text) =>
  String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

// Every [lon, lat] of some features' geometries (lines and rings alike).
export const ringsOf = (geometry) =>
  !geometry
    ? []
    : geometry.type === 'Polygon' || geometry.type === 'MultiLineString'
      ? geometry.coordinates
      : geometry.type === 'LineString'
        ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon'
          ? geometry.coordinates.flat()
          : [];

// A projection fitting a box [west, south, east, north] to the width (equirectangular, scaled for the latitude).
export function projection(box, width = WIDTH) {
  const [west, south, east, north] = box;
  const scaleX = Math.cos((((south + north) / 2) * Math.PI) / 180);
  const scale = width / ((east - west) * scaleX);
  const height = Math.round((north - south) * scale);
  return {
    width,
    height,
    point: ([lon, lat]) => [(lon - west) * scaleX * scale, (north - lat) * scale]
  };
}
export const boxOf = (features, pad = 0.02) => {
  const points = features.flatMap((feature) => ringsOf(feature.geometry).flat());
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const [west, east, south, north] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const [padX, padY] = [(east - west) * pad, (north - south) * pad];
  return [west - padX, south - padY, east + padX, north + padY];
};

// Douglas–Peucker: points within `tolerance` pixels of the line between their neighbors are dropped. A closed ring
// (its last point its first) is split at its point farthest from the start, and each half simplified.
export function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const [first, last] = [points[0], points.at(-1)];
  if (first[0] === last[0] && first[1] === last[1]) {
    let far = 1;
    points.forEach((point, index) => {
      if (
        Math.hypot(point[0] - first[0], point[1] - first[1]) >
        Math.hypot(points[far][0] - first[0], points[far][1] - first[1])
      )
        far = index;
    });
    return [
      ...simplifyOpen(points.slice(0, far + 1), tolerance),
      ...simplifyOpen(points.slice(far), tolerance).slice(1)
    ];
  }
  return simplifyOpen(points, tolerance);
}
export function simplifyOpen(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const length = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1;
    let farthest = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const [px, py] = points[index];
      const distance = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length;
      if (distance > farthest) [far, farthest] = [index, distance];
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([first, far], [far, last]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

// A path's d for some rings (closed for areas), projected and simplified.
export function pathOf(rings, project, { closed, tolerance = 0.6 }) {
  return rings
    .map((ring) => simplify(ring.map(project.point), tolerance))
    .filter((ring) => ring.length > (closed ? 2 : 1))
    .map(
      (ring) =>
        'M' +
        ring
          .map(([x, y]) => (tolerance >= 1 ? `${Math.round(x)} ${Math.round(y)}` : `${x.toFixed(1)} ${y.toFixed(1)}`))
          .join('L') +
        (closed ? 'Z' : '')
    )
    .join('');
}
// Where a label goes: the middle of an area's largest ring's points (good enough for districts and counties).
export function labelAt(geometry, project) {
  const ring = [...ringsOf(geometry)].sort((a, b) => b.length - a.length)[0] || [];
  const points = ring.map(project.point);
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

export const COLORS = ['#cfe3d0', '#f3d9b1', '#d6d3ee', '#f5c9c9', '#cde7f0', '#e9e4b7', '#e3cde7', '#c9e6dc'];

export function svgOf({ title, about, credits, project, body }) {
  const footer = 34;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${project.width} ${project.height + footer}" width="${project.width}" height="${project.height + footer}" font-family="system-ui, sans-serif">
<title>${escape(title)}</title>
<desc>${escape(about)} Sources: ${escape(credits.join('; '))}</desc>
<rect width="100%" height="100%" fill="#ffffff"/>
${body}
<text x="8" y="${project.height + 14}" font-size="11" fill="#555">${escape(title)}. ${escape(about)}</text>
<text x="8" y="${project.height + 28}" font-size="10" fill="#777">Sources: ${escape(credits.join('; '))}</text>
</svg>
`;
}
