import { useEffect, useRef, type DragEvent, type PointerEvent } from 'react';
import { LIBRARY_DRAG, type LibraryItem } from './LibraryPanel.tsx';
import { create } from '../../../src/vendor/qr/matrix-encoder.js';
import { mediaUrl } from '../data/hub.ts';
import { ASPECT, isOn, isSquare, opacityAt, setKeyAt, stateAt, type Layer } from './layers.ts';

// The layers drawn over the preview as the render will draw them (QR codes, pictures, a part of the video again,
// blurred areas), and the selected one in a box: drag it to move it (a keyframe at the playhead), drag its corner to
// resize it, and for a drawn blur shape, click inside to add its points. A click on another layer selects it.
const qrCache = new Map<string, { size: number; get: (row: number, column: number) => boolean }>();
function qrOf(text: string, level: string) {
  const key = `${level}|${text}`;
  if (!qrCache.has(key)) {
    try {
      qrCache.set(key, create(text || ' ', { errorCorrectionLevel: level }).modules);
    } catch {
      qrCache.set(key, { size: 1, get: () => false });
    }
  }
  return qrCache.get(key)!;
}
const images = new Map<string, HTMLImageElement>();
function imageOf(path: string, redraw: () => void) {
  if (!images.has(path)) {
    const image = new Image();
    image.onload = redraw;
    image.src = mediaUrl(path);
    images.set(path, image);
  }
  return images.get(path)!;
}

function drawQr(context: CanvasRenderingContext2D, text: string, layer: Layer, x: number, y: number, size: number) {
  const modules = qrOf(text, layer.level || 'M');
  const count = modules.size + 8;
  const cell = size / count;
  context.fillStyle = layer.background || '#ffffff';
  context.fillRect(x, y, size, size);
  context.fillStyle = layer.color || '#000000';
  for (let row = 0; row < modules.size; row += 1)
    for (let column = 0; column < modules.size; column += 1)
      if (modules.get(row, column))
        context.fillRect(x + (column + 4) * cell, y + (row + 4) * cell, Math.ceil(cell), Math.ceil(cell));
  if (layer.title) {
    context.font = `${Math.round(size * 0.11)}px system-ui, sans-serif`;
    const width = context.measureText(layer.title).width;
    const pad = size * 0.03;
    const top = y + size + size * 0.04;
    context.fillStyle = 'rgba(0, 0, 0, 0.6)';
    context.fillRect(x + (size - width) / 2 - pad, top, width + pad * 2, size * 0.15);
    context.fillStyle = '#fff';
    context.textBaseline = 'top';
    context.fillText(layer.title, x + (size - width) / 2, top + pad);
  }
}

function shapePath(context: CanvasRenderingContext2D, layer: Layer, x: number, y: number, w: number, h: number) {
  context.beginPath();
  if (layer.shape === 'ellipse') context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (layer.shape === 'polygon' && (layer.points || []).length >= 3)
    layer.points!.forEach(([px, py], index) =>
      index ? context.lineTo(x + px * w, y + py * h) : context.moveTo(x + px * w, y + py * h)
    );
  else context.rect(x, y, w, h);
  context.closePath();
}

export function drawLayers(
  context: CanvasRenderingContext2D,
  layers: Layer[],
  seconds: number,
  {
    video,
    officialAt,
    redraw
  }: { video: HTMLVideoElement | null; officialAt: (seconds: number) => string; redraw: () => void }
) {
  const { width: W, height: H } = context.canvas;
  const hasVideo = Boolean(video && video.readyState >= 2 && video.videoWidth);
  for (const layer of layers) {
    const alpha = opacityAt(layer, seconds);
    if (!alpha) continue;
    const { x: fx, y: fy, crop } = stateAt(layer, seconds);
    const [x, y, w, h] = [fx * W, fy * H, layer.size.w * W, layer.size.h * H];
    context.save();
    context.globalAlpha = alpha;
    if (layer.kind === 'qr' || layer.kind === 'official-qr')
      drawQr(context, layer.kind === 'qr' ? layer.url || '' : officialAt(seconds), layer, x, y, w);
    else if (layer.kind === 'image' && layer.image) {
      const image = imageOf(layer.image, redraw);
      if (image.complete && image.naturalWidth) {
        const [iw, ih] = [image.naturalWidth, image.naturalHeight];
        context.drawImage(image, crop.x * iw, crop.y * ih, crop.w * iw, crop.h * ih, x, y, w, h);
      }
    } else if (layer.kind === 'pip' && hasVideo) {
      const [vw, vh] = [video!.videoWidth, video!.videoHeight];
      context.drawImage(video!, crop.x * vw, crop.y * vh, crop.w * vw, crop.h * vh, x, y, w, h);
    } else if (layer.kind === 'blur') {
      shapePath(context, layer, x, y, w, h);
      context.clip();
      if (layer.effect === 'black' || !hasVideo) {
        context.fillStyle = layer.effect === 'black' ? '#000' : 'rgba(128, 128, 128, 0.6)';
        context.fillRect(x, y, w, h);
      } else {
        const [vw, vh] = [video!.videoWidth / W, video!.videoHeight / H];
        if (layer.effect === 'pixelate') {
          const block = Math.max(2, (layer.strength || 16) * (H / 720));
          const small = document.createElement('canvas');
          small.width = Math.max(1, Math.round(w / block));
          small.height = Math.max(1, Math.round(h / block));
          small.getContext('2d')!.drawImage(video!, x * vw, y * vh, w * vw, h * vh, 0, 0, small.width, small.height);
          context.imageSmoothingEnabled = false;
          context.drawImage(small, x, y, w, h);
        } else {
          context.filter = `blur(${(layer.strength || 14) * (H / 720)}px)`;
          context.drawImage(video!, 0, 0, video!.videoWidth, video!.videoHeight, 0, 0, W, H);
        }
      }
    }
    context.restore();
  }
}

export default function LayerCanvas({
  layers,
  seconds,
  video,
  playing,
  selected,
  editable,
  drawingPoints,
  officialAt,
  onSelect,
  onChange,
  onDropItem
}: {
  layers: Layer[];
  seconds: number;
  video: HTMLVideoElement | null;
  playing: boolean;
  selected: string | null;
  editable: boolean;
  // Adding points to the selected blur's drawn shape.
  drawingPoints: boolean;
  officialAt: (seconds: number) => string;
  onSelect: (id: string | null) => void;
  onChange: (layer: Layer) => void;
  // Something from the library dropped on the preview, where it was dropped.
  onDropItem: (item: LibraryItem, place: { x: number; y: number }) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const latest = useRef({ layers, seconds, video, officialAt });
  useEffect(() => {
    latest.current = { layers, seconds, video, officialAt };
  });
  // Drawn on each change, and each animation frame while playing (the video moves under pictures in picture and blurs).
  useEffect(() => {
    let request = 0;
    const draw = () => {
      const element = canvas.current;
      if (!element) return;
      const box = element.getBoundingClientRect();
      const width = Math.round(box.width * devicePixelRatio);
      if (element.width !== width) {
        element.width = width;
        element.height = Math.round(width / ASPECT);
      }
      const context = element.getContext('2d')!;
      context.clearRect(0, 0, element.width, element.height);
      const now = latest.current;
      drawLayers(context, now.layers, now.seconds, { video: now.video, officialAt: now.officialAt, redraw: draw });
      if (playing) request = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(request);
    // Drawn again when what's drawn changes (read through the ref, so the loop always draws the latest).
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [layers, seconds, video, playing, officialAt]);

  const layer = layers.find((item) => item.id === selected && isOn(item, seconds));
  const state = layer ? stateAt(layer, seconds) : null;
  const fraction = (event: { clientX: number; clientY: number }) => {
    const box = frame.current!.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  };
  // A click on the frame: the topmost layer there is selected (or a point is added to a drawn shape).
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    if (!editable || event.target !== event.currentTarget) return;
    const point = fraction(event);
    const hit = [...layers].reverse().find((item) => {
      if (!isOn(item, seconds)) return false;
      const at = stateAt(item, seconds);
      return point.x >= at.x && point.x <= at.x + item.size.w && point.y >= at.y && point.y <= at.y + item.size.h;
    });
    onSelect(hit?.id || null);
  };
  // Dragging the box (moving it) or its corner (resizing it).
  const drag = (mode: 'move' | 'resize') => (event: PointerEvent<HTMLElement>) => {
    if (!layer || !state || !editable) return;
    event.stopPropagation();
    event.preventDefault();
    const start = fraction(event);
    if (drawingPoints && mode === 'move' && layer.kind === 'blur') {
      const point: [number, number] = [
        Math.max(0, Math.min(1, (start.x - state.x) / layer.size.w)),
        Math.max(0, Math.min(1, (start.y - state.y) / layer.size.h))
      ];
      onChange({ ...layer, shape: 'polygon', points: [...(layer.points || []), point] });
      return;
    }
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    let changed = layer;
    const move = (moved: globalThis.PointerEvent) => {
      const now = fraction(moved);
      const [dx, dy] = [now.x - start.x, now.y - start.y];
      if (mode === 'move') changed = setKeyAt(layer, seconds, { x: state.x + dx, y: state.y + dy });
      else {
        const w = Math.max(0.03, Math.min(1, layer.size.w + dx));
        const h = isSquare(layer) ? w * ASPECT : Math.max(0.03, Math.min(1, layer.size.h + dy));
        changed = { ...layer, size: { w, h } };
      }
      onChange(changed);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- placing layers is for the pointer; the inspector's fields do it from the keyboard
    <div
      ref={frame}
      className={`layer-frame${editable ? ' editable' : ''}`}
      onPointerDown={pick}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        if (editable && event.dataTransfer.types.includes(LIBRARY_DRAG)) event.preventDefault();
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        const data = event.dataTransfer.getData(LIBRARY_DRAG);
        if (!data) return;
        event.preventDefault();
        onDropItem(JSON.parse(data) as LibraryItem, fraction(event));
      }}
    >
      <canvas ref={canvas} className="layer-canvas" aria-hidden="true" />
      {layer && state && editable && (
        // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- as above
        <div
          className={`layer-box${drawingPoints ? ' drawing' : ''}`}
          style={{
            left: `${state.x * 100}%`,
            top: `${state.y * 100}%`,
            width: `${layer.size.w * 100}%`,
            height: `${layer.size.h * 100}%`
          }}
          onPointerDown={drag('move')}
          title={drawingPoints ? 'Click to add a point to the shape' : 'Drag to move (a keyframe at the playhead)'}
        >
          <span className="layer-resize" onPointerDown={drag('resize')} title="Drag to resize" />
        </div>
      )}
    </div>
  );
}
