// Maps for the Maps section (collection maps, public): an SVG (its text, drawn from public data by build-maps, or
// added here) or a picture on the hub, with its group, what it shows, and the credits for its data.
export interface MapRecord {
  title: string;
  group: string;
  about?: string;
  credits?: string[];
  sources?: string[];
  kind: 'svg' | 'image';
  svg?: string;
  image?: string;
  createdAt?: string;
  builtAt?: string;
}
export const MAP_GROUPS = ['State', 'County', 'Town', 'Other'];
// An SVG as an address a picture (or a frame) can show.
export const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
