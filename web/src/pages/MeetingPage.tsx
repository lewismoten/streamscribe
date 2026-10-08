import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { putRecord, useRecords } from '../data/useRecords.ts';
import { syncNow } from '../data/sync.ts';
import { clock } from '../format.ts';
import { mediaUrlOf, type RecordingData } from './MeetingsPage.tsx';
import MediaPlayer, { type MediaData, type PlayerControl } from '../meeting/MediaPlayer.tsx';
import PublishPanel, { type PublishLine } from '../meeting/PublishPanel.tsx';
import OfficialPanel, { type Official } from '../meeting/OfficialPanel.tsx';
import MeetingHeader from '../meeting/MeetingHeader.tsx';
import Transcript from '../meeting/Transcript.tsx';
import { Chapters, Votes, type Chapter, type Vote } from '../meeting/Chapters.tsx';
import { captionsVtt } from '../meeting/captions.ts';
import { transcriptEdits } from '../meeting/edits.ts';
import { useFollowAlong } from '../meeting/useFollowAlong.ts';
import { correctedBy, markList, useMeetingMarks } from '../meeting/useMeetingMarks.ts';
import {
  buildLines,
  lineText,
  personName,
  speakersIn,
  type Chunk,
  type Person,
  type Still,
  type Turn,
  type Word
} from '../meeting/words.ts';
import { mergeOfficial, parseOfficialUrl } from '../../../src/sync/official.js';

// One meeting from the hub: its stills, chapters, votes, and transcript (the final one when it's ready, the quick
// one while recording), with the word corrections and speakers everyone may see. Signed in, a click on a word of the
// final transcript corrects it or says who is speaking from there; each person's changes are their own layer (see
// src/sync/layers.js), public if their group allows that kind of change and they're trusted, else theirs alone.
// The parts live in ../meeting: the transcript and its word editor, the player, and the side panels.
export default function MeetingPage() {
  const { id = '' } = useParams();
  const account = useAccount();
  const { records: recordings } = useRecords<RecordingData>('recordings');
  const { records: chunks } = useRecords<Chunk>('transcript_chunks');
  const { records: stills } = useRecords<Still>('stills');
  const { records: mediaRecords } = useRecords<MediaData>('media');
  const [picked, setPicked] = useState<Word | null>(null);
  const [partShown, setPartShown] = useState('');
  const [seek, setSeek] = useState<{ time: number; n: number } | null>(null);
  const player = useRef<PlayerControl>(null);
  const [status, setStatus] = useState('');
  const recording = recordings?.find((record) => record.id === id);
  const { stacks, markData, save } = useMeetingMarks({
    id,
    sourceKey: recording?.data.sourceKey,
    account,
    onSaved: setStatus
  });
  const mine = useMemo(() => (chunks || []).filter((chunk) => chunk.data.recordingId === id), [chunks, id]);
  const kind = mine.some((chunk) => chunk.data.kind === 'final') ? 'final' : 'quick';
  const editable = Boolean(account.user) && kind === 'final';

  const peopleId = recording ? `${recording.data.sourceKey}:people` : '';
  const people = markData<{ people?: Person[] }>(peopleId)?.people || [];
  const peopleMap = new Map(people.map((person) => [person.id, person]));
  const nameOf = (speaker: string) => personName(peopleMap.get(speaker), speaker);

  // Lines with their words (corrections applied), and who is speaking at each word.
  const lines = useMemo(() => buildLines(mine, kind, id, stacks), [mine, kind, id, stacks]);
  const speakersAt = (part: string, seconds: number) =>
    speakersIn(
      (markData<{ turns?: Turn[] }>(`${id}:${part}:speakers`)?.turns || []).slice().sort((a, b) => a.at - b.at),
      seconds
    );
  const edits = transcriptEdits({ id, peopleId, people, markData, save, closeEditor: () => setPicked(null) });

  const pictures = (stills || [])
    .filter((still) => still.data.recordingId === id)
    .sort((a, b) => a.data.partIndex - b.data.partIndex || a.data.position - b.data.position);
  // Chapters (agenda items), each with any official files of its own (links: draft minutes, attachments).
  const chapters = markList<Omit<Chapter, 'markId'>>(stacks, id, 'agenda', 'items');
  const votes = markList<Vote>(stacks, id, 'votes', 'votes');

  // Published audio and video (npm run publish-media), per part; the player follows the transcript's clicks.
  const media = (mediaRecords || [])
    .filter((record) => record.data.recordingId === id)
    .map((record) => record.data)
    .sort((a, b) => a.partIndex - b.partIndex);
  const playing = media.find((item) => item.part === partShown) || media[0];
  const canPlay = (part: string) => media.some((item) => item.part === part);
  const follow = useFollowAlong(lines, playing?.part);
  // Plays from a time: right away in the player showing that part (inside the click, as Safari needs), or by switching
  // to the part's player first (each seek is a new one, even to the same time).
  const playAt = (part: string, seconds: number) => {
    if (!canPlay(part)) return;
    follow.follow();
    if (playing?.part === part && player.current) {
      player.current.playFrom(seconds);
      return;
    }
    setPartShown(part);
    setSeek((previous) => ({ time: seconds, n: (previous?.n || 0) + 1 }));
  };

  // Opened at a moment (?part=…&t=…, from a person's page): go there once, when the meeting's media is known.
  const [params] = useSearchParams();
  const startAt = params.get('t');
  const startPart = params.get('part');
  const started = useRef(false);
  const firstMediaPart = media[0]?.part;
  const hasStartPart = Boolean(startPart && media.some((item) => item.part === startPart));
  useEffect(() => {
    if (started.current || startAt === null || !firstMediaPart) return;
    started.current = true;
    // oxlint-disable-next-line react/set-state-in-effect -- following the address once the synced media arrives
    setPartShown(hasStartPart && startPart ? startPart : firstMediaPart);
    setSeek((previous) => ({ time: Number(startAt), n: (previous?.n || 0) + 1 }));
  }, [firstMediaPart, hasStartPart, startAt, startPart]);

  if (account.checked && !can('view.meetings', account)) {
    return (
      <p className="empty">
        Meetings are private.{' '}
        {account.user ? (
          "Your group can't see them."
        ) : (
          <>
            <Link to="/account">Sign in</Link> if you may see them.
          </>
        )}{' '}
        <Link to="/">See what's published</Link>
      </p>
    );
  }
  if (!recordings) return <p className="empty">Loading…</p>;
  if (!recording)
    return (
      <p>
        No such meeting on the hub. <Link to="/meetings">All meetings</Link>
      </p>
    );
  const data = recording.data;
  // Official sources (src/sync/official.js): what the recorder knew (a built meeting's archive, lined up with it), with
  // what people set here over it (meeting-info, a mark). An older plain link still counts.
  const infoId = `${id}:${data.parts?.[0]?.name || ''}:meeting-info`;
  const info = markData<{ official?: Official; officialUrl?: string }>(infoId) || {};
  const legacy = info.officialUrl || data.officialUrl;
  const official = mergeOfficial(
    data.official || (legacy ? parseOfficialUrl(legacy) : null),
    info.official
  ) as Official | null;
  const saveOfficial = (next: Official) => save(infoId, { ...info, official: next }, 'Official sources saved');
  const editChapters = can('contribute.chapters', account);
  const addChapterFile = async (chapter: Chapter) => {
    const url = prompt(`An official file for “${chapter.title}” (such as its draft minutes or attachment):`);
    if (!url?.trim()) return;
    if (!/^https?:\/\//.test(url.trim())) {
      setStatus("That isn't a web address");
      return;
    }
    const label = prompt('What is it?', 'Attachment') || 'Attachment';
    const current = markData<{ items?: { id: string }[] }>(chapter.markId) || {};
    const items = (current.items || []).map((item) =>
      item.id === chapter.id
        ? { ...item, links: [...(chapter.links || []), { label: label.trim(), url: url.trim() }] }
        : item
    );
    await save(chapter.markId, { ...current, items }, `Added “${label.trim()}” to ${chapter.title}`);
  };
  // The transcript as shown (corrections, speaker names), for publishing and for the player's captions.
  const linesFor = (part: string): PublishLine[] =>
    lines
      .filter((line) => line.part === part)
      .map((line) => ({
        start: line.start,
        end: line.end,
        speaker: speakersAt(part, line.start + 0.01)
          .map(nameOf)
          .join(', '),
        text: lineText(line)
      }));
  const firstPart = data.parts?.[0]?.name || lines[0]?.part || '';
  const playChapterAt = playing ? (seconds: number) => playAt(playing.part, seconds) : null;
  const encodeQueued = async () => {
    await putRecord('jobs', `encode-${id}`, {
      type: 'encode',
      status: 'queued',
      title: `Audio and video: ${data.title}`,
      recordingId: id,
      progress: 0,
      message: '',
      agent: null,
      createdAt: new Date().toISOString(),
      createdBy: account.user?.displayName || account.user?.username || ''
    });
    setStatus('Queued for an agent (see Agents)');
    syncNow();
  };
  return (
    <article className="recording">
      <MeetingHeader
        recording={data}
        picture={pictures[0]?.data.path}
        account={account}
        hasMedia={media.length > 0}
        onEncode={encodeQueued}
      />
      {pictures.length > 0 && (
        <div className="stills">
          {pictures.map((still) =>
            canPlay(still.data.part) ? (
              <button
                key={still.id}
                type="button"
                className="still-button"
                title={`Play from ${clock(still.data.position)}`}
                aria-label={`Play from ${clock(still.data.position)}`}
                onClick={() => playAt(still.data.part, still.data.position)}
              >
                <img src={mediaUrlOf(still.data.path)} alt="" loading="lazy" />
              </button>
            ) : (
              <img
                key={still.id}
                src={mediaUrlOf(still.data.path)}
                alt=""
                loading="lazy"
                title={clock(still.data.position)}
              />
            )
          )}
        </div>
      )}
      <div className="recording-columns">
        <div className="side">
          {playing && (
            <div className="sticky-player">
              {media.length > 1 && (
                <fieldset className="segmented" aria-label="Part">
                  {media.map((item) => (
                    <button
                      key={item.part}
                      type="button"
                      className={item.part === playing.part ? 'on' : ''}
                      onClick={() => setPartShown(item.part)}
                    >
                      Part {item.partIndex + 1}
                    </button>
                  ))}
                </fieldset>
              )}
              <MediaPlayer
                key={playing.part}
                media={playing}
                seek={seek}
                control={player}
                stills={pictures
                  .filter((still) => still.data.part === playing.part)
                  .map((still) => ({ position: still.data.position, path: still.data.path }))}
                onTime={follow.onTime}
                captions={captionsVtt(linesFor(playing.part))}
              />
            </div>
          )}
          {can('publish', account) && (
            <PublishPanel
              recordingId={id}
              part={playing?.part || firstPart}
              seconds={playing?.seconds || data.durationSeconds || 0}
              playerTime={follow.currentTime}
              linesFor={linesFor}
              official={official}
              chapters={chapters.map((chapter) => ({
                at: chapter.at,
                title: chapter.title,
                links: chapter.links || []
              }))}
              clips={
                markData<{ clips?: { title: string; from: number; to: number }[] }>(
                  `${id}:${playing?.part || firstPart}:playlist`
                )?.clips || []
              }
            />
          )}
          <OfficialPanel
            official={official}
            playerTime={follow.currentTime}
            canEdit={editChapters}
            onSave={saveOfficial}
          />
          <Chapters
            chapters={chapters}
            official={official}
            playAt={playChapterAt}
            onAddFile={editChapters ? addChapterFile : null}
          />
          <Votes votes={votes} playAt={playChapterAt} />
        </div>
        <Transcript
          kind={kind}
          lines={lines}
          status={status}
          editable={editable}
          people={people}
          nameOf={nameOf}
          personHref={(speaker) =>
            peopleMap.has(speaker)
              ? `/people/${encodeURIComponent(data.sourceKey)}/${encodeURIComponent(speaker)}`
              : null
          }
          speakersAt={speakersAt}
          correctedBy={(word) => correctedBy(stacks, id, word)}
          canPlay={canPlay}
          playAt={playAt}
          listRef={follow.listRef}
          nowLine={follow.nowLine}
          following={follow.following}
          onFollow={follow.follow}
          playing={Boolean(playing)}
          picked={picked}
          onPick={setPicked}
          edits={edits}
        />
      </div>
    </article>
  );
}
