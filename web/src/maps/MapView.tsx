import { useState } from 'react';
import { mediaUrl } from '../data/hub.ts';
import type { MapRecord } from './types.ts';

// A map, large: an SVG in a sandboxed frame (so its hover labels work, and nothing in it can run), or a picture; with
// zoom (the frame scrolls to pan).
export default function MapView({ map }: { map: MapRecord }) {
  const [zoom, setZoom] = useState(1);
  // The frame takes the SVG's own shape (its viewBox).
  const box = map.svg?.match(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/);
  const aspect = box ? `${box[1]} / ${box[2]}` : '1 / 1';
  return (
    <div className="map-viewer">
      <div className="toolbar small">
        <button type="button" className="button" onClick={() => setZoom(Math.max(1, zoom / 1.5))} disabled={zoom <= 1}>
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" className="button" onClick={() => setZoom(Math.min(8, zoom * 1.5))}>
          ＋
        </button>
      </div>
      <div className="map-scroll">
        <div className="map-zoom" style={{ width: `${zoom * 100}%` }}>
          {map.kind === 'svg' && map.svg ? (
            <iframe
              title={map.title}
              style={{ aspectRatio: aspect }}
              sandbox=""
              srcDoc={`<!doctype html><style>html,body{margin:0}svg{width:100%;height:auto;display:block}</style>${map.svg}`}
            />
          ) : map.image ? (
            <img src={mediaUrl(map.image)} alt={map.title} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
