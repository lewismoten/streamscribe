import { useState, type FormEvent } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';
import { uploadPicture } from '../data/upload.ts';
import { mediaUrl } from '../data/hub.ts';
import MapView from './MapView.tsx';
import LayeredMapView from './LayeredMapView.tsx';
import { composeLayered, MAP_GROUPS, svgUrl, type MapRecord } from './types.ts';

// The Maps section: maps of the state, the county, and the town (drawn from public data by npm run build-maps and sent
// with publish-maps, or added here as an SVG or a picture), each with the credits for its data. People who may edit
// public bodies add and remove maps.
const LIMIT = 240 * 1024;
const now = () => new Date().toISOString();

function AddMap({ onDone }: { onDone: () => void }) {
  const [map, setMap] = useState<Partial<MapRecord>>({ group: 'County', kind: 'svg' });
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const read = async (file: File | undefined) => {
    if (!file) return;
    setProblem('');
    if (file.type === 'image/svg+xml' || file.name.endsWith('.svg')) {
      const svg = await file.text();
      if (svg.length > LIMIT) return setProblem('That SVG is over 240 KB; simplify it first (or add it as a picture)');
      setMap({ ...map, kind: 'svg', svg, image: undefined, title: map.title || file.name.replace(/\.[^.]+$/, '') });
    } else {
      setBusy(true);
      try {
        const sent = await uploadPicture(file);
        setMap({
          ...map,
          kind: 'image',
          image: sent.path,
          svg: undefined,
          title: map.title || file.name.replace(/\.[^.]+$/, '')
        });
      } catch (error) {
        setProblem((error as Error).message);
      } finally {
        setBusy(false);
      }
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!map.title?.trim() || !(map.svg || map.image)) return setProblem('A map needs a title and a file');
    await putRecord('maps', null, {
      ...map,
      title: map.title.trim(),
      credits: (map.credits || []).filter(Boolean),
      createdAt: now()
    });
    onDone();
  };
  return (
    <form className="panel schedule-form" onSubmit={save}>
      <h2>Add a map</h2>
      <label className="block">
        SVG or picture (PNG, JPEG, WebP)
        <input
          type="file"
          accept=".svg,image/svg+xml,image/png,image/jpeg,image/webp"
          onChange={(event) => read(event.target.files?.[0])}
        />
      </label>
      <div className="form-grid">
        <label>
          Title
          <input value={map.title || ''} onChange={(event) => setMap({ ...map, title: event.target.value })} />
        </label>
        <label>
          Group
          <select value={map.group} onChange={(event) => setMap({ ...map, group: event.target.value })}>
            {MAP_GROUPS.map((group) => (
              <option key={group}>{group}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="block">
        What it shows
        <input value={map.about || ''} onChange={(event) => setMap({ ...map, about: event.target.value })} />
      </label>
      <label className="block">
        Credits for its data (one per line)
        <textarea
          rows={2}
          value={(map.credits || []).join('\n')}
          onChange={(event) => setMap({ ...map, credits: event.target.value.split('\n') })}
        />
      </label>
      {map.kind === 'image' && map.image && (
        <p className="muted small">
          Pictures are kept with the meetings, so only people who may see meetings see them.
        </p>
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="toolbar">
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? 'Sending…' : 'Add the map'}
        </button>
        <button type="button" className="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function MapsPage() {
  const account = useAccount();
  const { records: maps } = useRecords<MapRecord>('maps');
  const [adding, setAdding] = useState(false);
  const editor = can('edit.bodies', account);
  if (!maps) return <p className="empty">Loading…</p>;
  // (A layered map's layers are records of their own, not maps to list.)
  const listed = maps.filter((map) => map.data.kind !== 'layer' && map.data.kind !== 'tiles');
  const hasTiles = maps.some((map) => map.data.kind === 'tiles');
  const layerSvg = (record: string) => maps.find((map) => map.id === record)?.data.svg || '';
  const groups = [...new Set([...MAP_GROUPS, ...listed.map((map) => map.data.group)])];
  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Maps</h1>
        {editor && !adding && (
          <button type="button" className="button primary" onClick={() => setAdding(true)}>
            ＋ Map
          </button>
        )}
      </div>
      {adding && <AddMap onDone={() => setAdding(false)} />}
      {hasTiles && (
        <p>
          <Link className="button primary" to="/maps/explore">
            🗺 Explore the map
          </Link>{' '}
          <span className="muted small">
            zoom from the state to the county&apos;s roads, with its districts and fire areas
          </span>
        </p>
      )}
      {listed.length === 0 && (
        <p className="empty">
          No maps yet. On the recording machine: <code>npm run fetch-maps</code>, <code>npm run build-maps</code>, then{' '}
          <code>npm run publish-maps</code>.
        </p>
      )}
      {groups.map((group) => {
        const inGroup = listed
          .filter((map) => map.data.group === group)
          .sort((a, b) => a.data.title.localeCompare(b.data.title));
        if (!inGroup.length) return null;
        return (
          <section key={group}>
            <h2>{group}</h2>
            <ul className="map-cards">
              {inGroup.map((map) => (
                <li key={map.id} className="panel">
                  <Link to={`/maps/${encodeURIComponent(map.id)}`}>
                    {map.data.kind === 'layered' ? (
                      <img
                        src={svgUrl(
                          composeLayered(map.data, layerSvg, {
                            shown: new Set(
                              (map.data.layers || []).filter((layer) => layer.on).map((layer) => layer.id)
                            ),
                            shaded: new Set()
                          })
                        )}
                        alt=""
                        loading="lazy"
                      />
                    ) : map.data.kind === 'svg' && map.data.svg ? (
                      <img src={svgUrl(map.data.svg)} alt="" loading="lazy" />
                    ) : map.data.image ? (
                      <img src={mediaUrl(map.data.image)} alt="" loading="lazy" />
                    ) : null}
                    <strong>{map.data.title}</strong>
                  </Link>
                  {map.data.about && <p className="muted small">{map.data.about}</p>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}

export function MapPage() {
  const { id = '' } = useParams();
  const account = useAccount();
  const navigate = useNavigate();
  const { records: maps } = useRecords<MapRecord>('maps');
  const map = maps?.find((item) => item.id === id);
  if (!maps) return <p className="empty">Loading…</p>;
  if (!map)
    return (
      <p>
        No such map. <Link to="/maps">All maps</Link>
      </p>
    );
  return (
    <article>
      <div className="card-kind">
        <Link to="/maps">Maps</Link> · {map.data.group}
      </div>
      <div className="toolbar">
        <h1 className="grow">{map.data.title}</h1>
        {map.data.kind === 'svg' && map.data.svg && (
          <a className="button" href={svgUrl(map.data.svg)} download={`${id}.svg`}>
            Download SVG
          </a>
        )}
        {can('edit.bodies', account) && (
          <button
            type="button"
            className="link-button danger"
            onClick={async () => {
              if (!confirm(`Remove the map “${map.data.title}”?`)) return;
              await removeRecord('maps', id);
              navigate('/maps');
            }}
          >
            Remove
          </button>
        )}
      </div>
      {map.data.about && <p>{map.data.about}</p>}
      {map.data.kind === 'layered' ? (
        <LayeredMapView map={map.data} layerSvg={(record) => maps.find((item) => item.id === record)?.data.svg || ''} />
      ) : (
        <MapView map={map.data} />
      )}
      {(map.data.credits || []).length > 0 && (
        <section className="small map-credits">
          <h2>Credits</h2>
          <ul>
            {map.data.credits!.map((credit) => (
              <li key={credit}>{credit}</li>
            ))}
          </ul>
          {(map.data.sources || []).length > 0 && (
            <p className="muted">
              Data from:{' '}
              {map.data.sources!.map((url, index) => (
                <span key={url}>
                  {index > 0 && ', '}
                  <a href={url} target="_blank" rel="noreferrer">
                    {new URL(url).hostname}
                  </a>
                </span>
              ))}
            </p>
          )}
        </section>
      )}
    </article>
  );
}
