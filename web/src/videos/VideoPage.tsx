import { useEffect, useRef, useState } from 'react';
import LayerCanvas from './LayerCanvas.tsx';
import LayerInspector from './LayerInspector.tsx';
import LibraryPanel, { type LibraryItem } from './LibraryPanel.tsx';
import { newLayer, type Layer, type LayerKind } from './layers.ts';
import { useOfficials } from './useOfficials.ts';
import { Link, useNavigate, useParams } from 'react-router';
import { newId } from '../../../src/sync/collections.js';
import { can, useAccount } from '../data/account.ts';
import { syncClient } from '../data/sync.ts';
import { putRecord, removeRecord, useRecords, type HubRecord } from '../data/useRecords.ts';
import { clock } from '../format.ts';
import type { Publication } from '../published/types.ts';
import ClipLibrary from './ClipLibrary.tsx';
import Inspector from './Inspector.tsx';
import { allOverlays, OVERLAY_KINDS, useOverlays, type OverlayKind } from './overlays.ts';
import PreviewPlayer from './PreviewPlayer.tsx';
import RenderDialog from './RenderDialog.tsx';
import Timeline from './Timeline.tsx';
import { itemAt, itemOf, layout, type Clip, type Video, type VideoItem } from './types.ts';

// Putting a video together, like a movie editor: the clip library on the left, the preview (sound and picture, with
// its overlays) in the middle, the selected clip's settings on the right, and the timeline along the bottom (clips
// dragged into order, their ends dragged to trim, split at the playhead, deleted; the sound track; who is speaking
// when), with the layers over it (QR codes, pictures, pictures in picture, blurred areas: dragged from the library
// onto the preview, placed and keyframed there and in their inspector; see layers.ts). Keys: Space plays and pauses,
// S splits at the playhead, Delete takes out the selected clip. Rendering has an agent make it from the meetings'
// recordings, for the hub or a folder (RenderDialog).
const now = () => new Date().toISOString();

export default function VideoPage() {
  const { id = '' } = useParams();
  const account = useAccount();
  const navigate = useNavigate();
  const { records: videos } = useRecords<Video>('videos');
  const { records: clips } = useRecords<Clip>('clips');
  const { records: publications } = useRecords<Publication>('publications');
  const { records: stills } = useRecords<{ recordingId: string; part: string; position: number; path: string }>(
    'stills'
  );
  const overlaysOf = useOverlays();
  const { officialOf, officialAt } = useOfficials();
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [drawingPoints, setDrawingPoints] = useState(false);
  // Layers as they're being dragged (saved once the dragging pauses).
  const [layerDraft, setLayerDraft] = useState<Layer[] | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [message, setMessage] = useState('');
  // The title and description as typed (saved when left), so typing isn't interrupted by saving.
  const [draft, setDraft] = useState<{ id: string; title: string; description: string } | null>(null);
  // Changes are saved one at a time, each to the video as last saved.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = (change: Partial<Video> | ((current: Video) => Partial<Video>)) => {
    queue.current = queue.current.then(async () => {
      const current = (await syncClient().get('videos', id))?.data as Video | undefined;
      if (!current) return;
      await putRecord('videos', id, {
        ...current,
        ...(typeof change === 'function' ? change(current) : change),
        updatedAt: now()
      });
    });
    return queue.current;
  };
  const record = videos?.find((item) => item.id === id);
  const video = record?.data;
  const items = video?.items || [];
  const kinds = { ...allOverlays(), ...video?.overlays };
  const { total } = layout(items);
  const changeItems = (change: (current: VideoItem[]) => VideoItem[]) =>
    save((current) => ({ items: change(current.items) }));
  const layers = layerDraft || video?.layers || [];
  const setLayers = (next: Layer[]) => {
    setLayerDraft(next);
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      save({ layers: next }).then(() => setLayerDraft((pending) => (pending === next ? null : pending)));
    }, 350);
  };
  const changeLayer = (layer: Layer) => setLayers(layers.map((item) => (item.id === layer.id ? layer : item)));
  const addLayer = (layer: Layer) => {
    setLayers([...layers, layer]);
    setSelectedLayer(layer.id);
    setSelected(null);
  };
  const addFromLibrary = (item: LibraryItem, place?: { x: number; y: number }) =>
    addLayer(
      item.kind === 'image'
        ? newLayer(
            'image',
            time,
            total,
            { image: item.path, imageWidth: item.width, imageHeight: item.height, name: item.label },
            place
          )
        : newLayer('qr', time, total, { url: item.url, title: item.label, name: item.label }, place)
    );
  // For the agent: an official video QR code gets the official video's address for each second it shows.
  const layersToRender = () =>
    layers.map((layer) => {
      if (layer.kind !== 'official-qr') return layer;
      const urls: { at: number; url: string }[] = [];
      for (let second = 0; second < Math.ceil(layer.to - layer.from); second += 1) {
        const url = officialAt(items, layer.from + second);
        if (url && url !== urls.at(-1)?.url) urls.push({ at: second, url });
      }
      return { ...layer, urls };
    });
  // Splitting the clip under the playhead in two there.
  const split = () => {
    if (!items.length) return;
    const index = itemAt(items, time);
    const item = items[index];
    const at = item.from + (time - layout(items).starts[index]);
    if (at - item.from < 0.5 || item.to - at < 0.5) return setMessage('Too near the clip’s start or end to split');
    const second = { ...item, key: newId(), from: Math.round(at * 10) / 10 };
    changeItems((current) =>
      current.flatMap((other) => (other.key === item.key ? [{ ...other, to: second.from }, second] : [other]))
    );
    setSelected(second.key);
  };
  const removeSelected = () => {
    if (selectedLayer && !selected) {
      setLayers(layers.filter((layer) => layer.id !== selectedLayer));
      setSelectedLayer(null);
      return;
    }
    if (!selected) return;
    changeItems((current) => current.filter((item) => item.key !== selected));
    setSelected(null);
  };
  // Keys, when not typing (the latest split and delete, through a ref).
  const actions = useRef({ split, removeSelected });
  useEffect(() => {
    actions.current = { split, removeSelected };
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable], dialog')) return;
      if (event.key === ' ') {
        event.preventDefault();
        setPlaying((value) => !value);
      } else if (event.key === 's' || event.key === 'S') actions.current.split();
      else if (event.key === 'Delete' || event.key === 'Backspace') actions.current.removeSelected();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
    // Listened for once; the latest actions come through the ref.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, []);

  if (!can('view.meetings', account)) return <p className="empty">Videos are made from meetings, which are private.</p>;
  if (!videos || !clips) return <p className="empty">Loading…</p>;
  if (!record || !video)
    return (
      <p>
        No such video. <Link to="/videos">All videos</Link>
      </p>
    );
  const editable = Boolean(account.user);
  const publication = video.publicationId ? publications?.find((item) => item.id === video.publicationId) : undefined;
  const typed = draft?.id === id ? draft : { id, title: video.title, description: video.description };
  const selectedIndex = items.findIndex((item) => item.key === selected);
  // A clip from the library goes after the clip under the playhead (or at the end).
  const add = (clip: HubRecord<Clip>) => {
    const item = itemOf(clip.id, clip.data);
    const at = items.length ? itemAt(items, time) + 1 : 0;
    changeItems((current) => [...current.slice(0, at), item, ...current.slice(at)]);
    setSelected(item.key);
  };

  return (
    <article className="video-editor">
      <div className="card-kind">
        <Link to="/videos">Videos</Link>
      </div>
      <div className="toolbar">
        <input
          className="video-title grow"
          value={typed.title}
          onChange={(event) => setDraft({ ...typed, title: event.target.value })}
          onBlur={() => typed.title !== video.title && save({ title: typed.title })}
          onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
          disabled={!editable}
          aria-label="The video's title"
        />
        {can('publish', account) && (
          <button type="button" className="button primary" onClick={() => setRendering(true)} disabled={!items.length}>
            Render…
          </button>
        )}
        {editable && (
          <button
            type="button"
            className="link-button danger"
            onClick={async () => {
              if (!confirm(`Delete the video “${video.title}”? (Anything rendered from it stays.)`)) return;
              await removeRecord('videos', id);
              navigate('/videos');
            }}
          >
            Delete
          </button>
        )}
      </div>
      {message && <p className="note">{message}</p>}
      {publication && (
        <p className="small">
          Published as <Link to={`/published/${publication.id}`}>{publication.data.title}</Link>
          {publication.data.clip?.status === 'ready'
            ? ' (ready)'
            : publication.data.clip?.status === 'failed'
              ? ` (couldn't be made: ${publication.data.clip.error || 'unknown error'})`
              : ' (an agent is making it)'}
        </p>
      )}

      <div className="editor-grid">
        <div className="editor-left">
          <ClipLibrary clips={clips} editable={editable} onAdd={add} />
          <LibraryPanel
            editable={editable}
            officials={[...new Set(items.map((item) => item.recordingId))].map(officialOf)}
            onAdd={(item) => addFromLibrary(item)}
            onAddLayer={(kind: LayerKind) => addLayer(newLayer(kind, time, total))}
          />
        </div>
        <section className="panel editor-preview">
          <PreviewPlayer
            items={items}
            time={time}
            playing={playing}
            onTime={setTime}
            onPlaying={setPlaying}
            overlaysOf={overlaysOf}
            kinds={kinds}
            renderLayers={(element) => (
              <LayerCanvas
                layers={layers}
                seconds={time}
                video={element}
                playing={playing}
                selected={selectedLayer}
                editable={editable}
                drawingPoints={drawingPoints}
                officialAt={(seconds) => officialAt(items, seconds)}
                onSelect={(layerId) => {
                  setSelectedLayer(layerId);
                  if (layerId) setSelected(null);
                }}
                onChange={changeLayer}
                onDropItem={addFromLibrary}
              />
            )}
          />
          <div className="toolbar transport">
            <button
              type="button"
              className="button"
              onClick={() => setTime(0)}
              aria-label="To the start"
              disabled={!items.length}
            >
              ⏮
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => setPlaying(!playing)}
              disabled={!items.length}
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? '⏸ Pause' : '▶ Play'}
            </button>
            <span className="small">
              {clock(time)} / {clock(total)}
            </span>
            <span className="grow" />
            {editable && (
              <>
                <button
                  type="button"
                  className="button"
                  onClick={split}
                  disabled={!items.length}
                  title="Split at the playhead (S)"
                >
                  ✂ Split
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={removeSelected}
                  disabled={!selected}
                  title="Delete the selected clip (Delete)"
                >
                  Delete clip
                </button>
              </>
            )}
          </div>
        </section>
        <aside className="editor-side">
          {selectedLayer && editable && layers.some((layer) => layer.id === selectedLayer) ? (
            <LayerInspector
              layer={layers.find((layer) => layer.id === selectedLayer)!}
              time={time}
              total={total}
              drawingPoints={drawingPoints}
              onDrawingPoints={setDrawingPoints}
              onChange={changeLayer}
              onSeek={setTime}
              onRemove={() => {
                setLayers(layers.filter((layer) => layer.id !== selectedLayer));
                setSelectedLayer(null);
              }}
              onMove={(direction) => {
                const at = layers.findIndex((layer) => layer.id === selectedLayer);
                const to = at + direction;
                if (to < 0 || to >= layers.length) return;
                const moved = [...layers];
                [moved[at], moved[to]] = [moved[to], moved[at]];
                setLayers(moved);
              }}
            />
          ) : selectedIndex >= 0 && editable ? (
            <Inspector
              item={items[selectedIndex]}
              index={selectedIndex}
              count={items.length}
              onChange={(next) =>
                changeItems((current) => current.map((item) => (item.key === next.key ? next : item)))
              }
              onMove={(to) =>
                changeItems((current) => {
                  if (to < 0 || to >= current.length) return current;
                  const moved = [...current];
                  const [item] = moved.splice(selectedIndex, 1);
                  moved.splice(to, 0, item);
                  return moved;
                })
              }
              onRemove={removeSelected}
            />
          ) : (
            <p className="muted small panel">Select a clip on the timeline to change it.</p>
          )}
          <section className="panel">
            <h2>Overlays</h2>
            {(Object.keys(OVERLAY_KINDS) as OverlayKind[]).map((kind) => (
              <label key={kind} className="inline overlay-choice">
                <input
                  type="checkbox"
                  checked={kinds[kind]}
                  disabled={!editable}
                  onChange={(event) =>
                    save((current) => ({ overlays: { ...current.overlays, [kind]: event.target.checked } }))
                  }
                />{' '}
                {OVERLAY_KINDS[kind]}
              </label>
            ))}
          </section>
          <label className="block">
            Description (with it when published)
            <textarea
              rows={3}
              value={typed.description}
              onChange={(event) => setDraft({ ...typed, description: event.target.value })}
              onBlur={() => typed.description !== video.description && save({ description: typed.description })}
              disabled={!editable}
            />
          </label>
        </aside>
      </div>

      <Timeline
        items={items}
        time={time}
        selected={selected}
        stills={(stills || []).map((still) => still.data)}
        overlaysOf={overlaysOf}
        onSeek={(seconds) => setTime(seconds)}
        onSelect={(key) => {
          setSelected(key);
          setSelectedLayer(null);
        }}
        onChange={(next) => changeItems(() => next)}
        layers={layers}
        selectedLayer={selectedLayer}
        onSelectLayer={(layerId) => {
          setSelectedLayer(layerId);
          setSelected(null);
        }}
        onLayerChange={changeLayer}
      />

      {rendering && (
        <RenderDialog
          videoId={id}
          beforeRender={() => queue.current}
          layers={layersToRender}
          overlays={() =>
            Object.fromEntries(
              items.map((item) => [item.key, overlaysOf(item).filter((overlay) => kinds[overlay.kind])])
            )
          }
          onClose={() => setRendering(false)}
          onDone={(text) => {
            setRendering(false);
            setMessage(text);
          }}
        />
      )}
    </article>
  );
}
