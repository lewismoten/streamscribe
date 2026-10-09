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
import AttendancePanel from '../meeting/AttendancePanel.tsx';
import PrayerPanel from '../meeting/PrayerPanel.tsx';
import RoomPanel from '../meeting/RoomPanel.tsx';
import ConsentPanel from '../meeting/ConsentPanel.tsx';
import DocumentDialog from '../meeting/DocumentDialog.tsx';
import { consentMarkId, meetingDocuments, type ConsentItem, type DocumentLink } from '../meeting/documents.ts';
import { roomIdOf, type CameraView, type Room } from '../rooms/types.ts';
import Dialog from '../Dialog.tsx';
import ClipForm from '../videos/ClipForm.tsx';
import ClipsPanel from '../videos/ClipsPanel.tsx';
import { saveClip, type Clip } from '../videos/types.ts';
import type { Attendance } from '../people/usePeople.ts';
import type { Ring } from '../people/Avatar.tsx';
import { activeOn, bodiesOfRecording, MEMBER_KINDS, STAFF_KINDS, type Body, type Term } from '../civic/types.ts';
import { dayKey } from '../format.ts';
import MeetingHeader from '../meeting/MeetingHeader.tsx';
import Transcript from '../meeting/Transcript.tsx';
import { Chapters, Votes, type Chapter, type Vote } from '../meeting/Chapters.tsx';
import { captionsVtt } from '../meeting/captions.ts';
import { lineLinks, linksIn, linksMarkId, type TranscriptLink } from '../meeting/links.ts';
import { useScriptureSite } from '../religion/bible.ts';
import { newId } from '../../../src/sync/collections.js';
import { transcriptEdits } from '../meeting/edits.ts';
import { useFollowAlong } from '../meeting/useFollowAlong.ts';
import { correctedBy, markList, useMeetingMarks } from '../meeting/useMeetingMarks.ts';
import ReviewProgress from '../meeting/ReviewProgress.tsx';
import MeetingTasks from '../prompts/MeetingTasks.tsx';
import SlidesPanel from '../meeting/SlidesPanel.tsx';
import { slidesIn, useSlides } from '../meeting/slides.ts';
import { minutesByPart, minutesOf, reviewedMarkId, reviewProgress, type ReviewField } from '../meeting/review.ts';
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
import { isTimed, mergeOfficial, officialLinks, parseOfficialUrl, videoAt } from '../../../src/sync/official.js';

// One meeting from the hub: its stills, chapters, votes, and transcript (the final one when it's ready, the quick
// one while recording), with the word corrections and speakers everyone may see. Signed in, a click on a word of the
// final transcript corrects it or says who is speaking from there; each person's changes are their own layer (see
// src/sync/layers.js), public if their group allows that kind of change and they're trusted, else theirs alone.
// The parts live in ../meeting: the transcript and its word editor, the player, and the side panels.
const stamp = () => new Date().toISOString();

export default function MeetingPage() {
  const { id = '' } = useParams();
  const account = useAccount();
  const { records: recordings } = useRecords<RecordingData>('recordings');
  const { records: chunks } = useRecords<Chunk>('transcript_chunks');
  const { records: stills } = useRecords<Still>('stills');
  const { records: mediaRecords } = useRecords<MediaData>('media');
  const { records: terms } = useRecords<Term>('terms');
  const { records: bodies } = useRecords<Body>('bodies');
  const { records: rooms } = useRecords<Room>('rooms');
  const { records: schedules } = useRecords<{ roomId?: string }>('schedules');
  const [picked, setPicked] = useState<Word | null>(null);
  const [partShown, setPartShown] = useState('');
  const [seek, setSeek] = useState<{ time: number; n: number } | null>(null);
  const player = useRef<PlayerControl>(null);
  const [status, setStatus] = useState('');
  // Words selected in the transcript, being saved as a clip.
  const [clipDraft, setClipDraft] = useState<{ part: string; from: number; to: number; title: string } | null>(null);
  // The documents dialog: open (for a consent item or chapter to start with, or neither).
  const [addingDocuments, setAddingDocuments] = useState<
    { kind: 'consent'; itemId: string } | { kind: 'chapter'; chapterId: string } | 'open' | null
  >(null);
  const recording = recordings?.find((record) => record.id === id);
  const { stacks, markData, save } = useMeetingMarks({
    id,
    sourceKey: recording?.data.sourceKey,
    account,
    onSaved: setStatus
  });
  const mine = useMemo(() => (chunks || []).filter((chunk) => chunk.data.recordingId === id), [chunks, id]);
  // Whisper's final transcript, else the provider's automated one (a past meeting found elsewhere), else the quick one.
  const kind = mine.some((chunk) => chunk.data.kind === 'final')
    ? 'final'
    : mine.some((chunk) => chunk.data.kind === 'official')
      ? 'official'
      : 'quick';
  const editable = Boolean(account.user) && kind === 'final';

  const peopleId = recording ? `${recording.data.sourceKey}:people` : '';
  const people = markData<{ people?: Person[] }>(peopleId)?.people || [];
  const peopleMap = new Map(people.map((person) => [person.id, person]));
  const nameOf = (speaker: string) => personName(peopleMap.get(speaker), speaker);
  // Speakers' photos, private ones included (this page is only for people who may see meetings).
  const photos =
    markData<{ photos?: Record<string, { path: string }> }>(`${recording?.data.sourceKey}:people-photos`)?.photos || {};
  // A ring for what each speaker was that day, from their terms (see ../civic): a voting member of the body meeting,
  // staff, or an elected official serving elsewhere.
  const meetingDay = dayKey(recording?.data.startedAt || null);
  const meetingBodies = recording
    ? bodiesOfRecording(bodies || [], recording.data, markData<Attendance>(`${id}:attendance`)?.bodyId)
    : [];
  const ringOf = (speaker: string): Ring | undefined => {
    const own = (terms || [])
      .map((term) => term.data)
      .filter(
        (term) =>
          term.sourceKey === recording?.data.sourceKey && term.personId === speaker && activeOn(term, meetingDay)
      );
    if (own.some((term) => MEMBER_KINDS.includes(term.kind) && meetingBodies.some((body) => body.id === term.bodyId)))
      return 'voting';
    if (own.some((term) => STAFF_KINDS.includes(term.kind))) return 'staff';
    if (own.some((term) => term.kind === 'elected')) return 'elected';
    return undefined;
  };
  const avatarOf = (speaker: string) => ({
    ...(peopleMap.get(speaker) || { id: speaker }),
    name: nameOf(speaker),
    photo: photos[speaker]?.path || null,
    ring: ringOf(speaker)
  });

  // Lines with their words (corrections applied), and who is speaking at each word.
  const lines = useMemo(() => buildLines(mine, kind, id, stacks), [mine, kind, id, stacks]);
  const speakersAt = (part: string, seconds: number) =>
    speakersIn(
      (markData<{ turns?: Turn[] }>(`${id}:${part}:speakers`)?.turns || []).slice().sort((a, b) => a.at - b.at),
      seconds
    );
  // Links on phrases of the transcript (web pages, Bible passages), a mark per part.
  const scriptureSite = useScriptureSite();
  const linksFor = (part: string) => linksIn(stacks, id, part);
  const slides = useSlides(id);
  // Checking the transcript a minute at a time.
  const checksOf = (part: string) => minutesOf(stacks, id, part);
  const toggleMinute = (part: string, minute: number, field: ReviewField) => {
    const minutes = checksOf(part);
    const check = { ...minutes[minute], [field]: !minutes[minute]?.[field] };
    return save(
      reviewedMarkId(id, part),
      { minutes: { ...minutes, [minute]: check } },
      `${clock(minute * 60)}: ${field} ${check[field] ? 'checked' : 'not checked'}`
    );
  };
  const saveLink = (part: string, link: Omit<TranscriptLink, 'id'> & { id?: string }) => {
    const items = linksFor(part).filter((item) => item.id !== link.id);
    const saved = { ...link, id: link.id || newId() } as TranscriptLink;
    return save(linksMarkId(id, part), { items: [...items, saved] }, `Linked “${saved.text}”`);
  };
  const removeLink = (part: string, link: TranscriptLink) =>
    save(
      linksMarkId(id, part),
      { items: linksFor(part).filter((item) => item.id !== link.id) },
      `Removed the link on “${link.text}”`
    );
  const edits = transcriptEdits({ id, peopleId, people, markData, save, closeEditor: () => setPicked(null) });

  const pictures = (stills || [])
    .filter((still) => still.data.recordingId === id)
    .sort((a, b) => a.data.partIndex - b.data.partIndex || a.data.position - b.data.position);
  // Chapters (agenda items), each with any official files of its own (links: draft minutes, attachments).
  const chapters = markList<Omit<Chapter, 'markId'>>(stacks, id, 'agenda', 'items');
  const votes = markList<Vote>(stacks, id, 'votes', 'votes');
  const spoke = [...new Set(markList<Turn>(stacks, id, 'speakers', 'turns').flatMap((turn) => turn.speakers || []))];
  const attendanceId = `${id}:attendance`;

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
  // A chapter's own file (its draft minutes, an attachment), added in the documents dialog.
  const addChapterLink = async (chapter: Chapter, link: DocumentLink) => {
    const current = markData<{ items?: { id: string }[] }>(chapter.markId) || {};
    const items = (current.items || []).map((item) =>
      item.id === chapter.id
        ? { ...item, links: [...(chapter.links || []).filter((other) => other.url !== link.url), link] }
        : item
    );
    await save(chapter.markId, { ...current, items }, `Added “${link.label}” to ${chapter.title}`);
  };
  // The consent agenda (a mark of the meeting), and every document of the meeting, to link transcript words to.
  const consent = markData<{ items?: ConsentItem[] }>(consentMarkId(id))?.items || [];
  const saveConsent = (items: ConsentItem[], done: string) => save(consentMarkId(id), { items }, done);
  // Where the meeting is (its room's town and ZIP), left out of addresses there when naming places.
  const meetingRoom = rooms?.find(
    (item) =>
      item.id ===
      roomIdOf({
        chosen: (info as { roomId?: string }).roomId,
        occurrenceKey: data.occurrenceKey,
        schedules: schedules || [],
        meetingBodies
      })
  )?.data;
  const around = meetingRoom ? { city: meetingRoom.city, postal: meetingRoom.postal } : undefined;
  const documents = meetingDocuments({ consent, chapters, official: officialLinks(official) });
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
        speakers: speakersAt(part, line.start + 0.01),
        text: lineText(line),
        links: lineLinks(line, linksFor(part), scriptureSite)
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
  // A clip of this meeting, as saved (with the meeting's title and day, for clip lists across meetings).
  const newClip = (part: string, from: number, to: number, title: string): Clip => ({
    recordingId: id,
    part,
    from,
    to,
    title,
    sourceKey: data.sourceKey,
    meeting: data.title,
    recordedAt: data.startedAt || null,
    createdAt: stamp(),
    createdBy: account.user?.displayName || account.user?.username || ''
  });
  return (
    <article className="recording">
      {addingDocuments && (
        <DocumentDialog
          consent={consent}
          chapters={chapters}
          start={addingDocuments === 'open' ? null : addingDocuments}
          onConsent={saveConsent}
          onChapterLink={addChapterLink}
          onClose={() => setAddingDocuments(null)}
        />
      )}
      {clipDraft && (
        <Dialog title="Save as a clip" onClose={() => setClipDraft(null)}>
          <ClipForm
            title={clipDraft.title}
            from={clipDraft.from}
            to={clipDraft.to}
            onCancel={() => setClipDraft(null)}
            onSave={async (value) => {
              await saveClip(null, newClip(clipDraft.part, value.from, value.to, value.title));
              setClipDraft(null);
              setStatus(`Saved the clip “${value.title}” (Clips)`);
            }}
          />
        </Dialog>
      )}
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
            onAddFile={
              editChapters ? (chapter) => setAddingDocuments({ kind: 'chapter', chapterId: chapter.id }) : null
            }
            slidesOf={(from, to) => (playing ? slidesIn(slides, playing.part, from, to) : [])}
          />
          <SlidesPanel slides={slides} playAt={playing ? playAt : null} />
          <ConsentPanel
            items={consent}
            canEdit={editChapters}
            playerTime={follow.currentTime}
            playAt={playChapterAt}
            onSave={saveConsent}
            onAdd={(item) => setAddingDocuments(item ? { kind: 'consent', itemId: item.id } : 'open')}
          />
          <Votes votes={votes} playAt={playChapterAt} />
          <RoomPanel
            recordingId={id}
            part={firstPart}
            occurrenceKey={data.occurrenceKey}
            meetingBodies={meetingBodies}
            info={info as { roomId?: string } & Record<string, unknown>}
            views={markData<{ views?: CameraView[] }>(`${id}:${firstPart}:views`)?.views || []}
            account={account}
            save={save}
          />
          <ClipsPanel
            recordingId={id}
            playlist={(data.parts || []).flatMap((item) =>
              (
                markData<{ clips?: { title: string; from: number; to: number }[] }>(`${id}:${item.name}:playlist`)
                  ?.clips || []
              ).map((clip) => ({ ...clip, part: item.name }))
            )}
            canEdit={Boolean(account.user)}
            playAt={playing ? playAt : null}
            newClip={newClip}
          />
          <PrayerPanel
            recordingId={id}
            sourceKey={data.sourceKey}
            part={playing?.part || firstPart}
            people={people}
            playerTime={follow.currentTime}
            markData={markData}
            save={save}
            canEdit={Boolean(account.user)}
            playAt={playing ? playAt : null}
          />
          <MeetingTasks recordingId={id} title={data.title} />
          <AttendancePanel
            recordingId={id}
            recording={data}
            attendance={markData<Attendance>(attendanceId) || {}}
            spoke={spoke}
            nameOf={nameOf}
            canEdit={Boolean(account.user)}
            onSave={(next, message) => save(attendanceId, { ...next }, message)}
            people={people}
            moment={() => (playing ? { part: playing.part, seconds: follow.currentTime() } : null)}
            onPlay={playing ? playAt : null}
            onAddPerson={edits.newPerson}
          />
        </div>
        <Transcript
          recordingId={id}
          minuteChecks={kind === 'final' ? checksOf : undefined}
          onMinuteCheck={toggleMinute}
          progress={
            kind === 'final' && (
              <ReviewProgress
                progress={reviewProgress(minutesByPart(lines), checksOf)}
                onNext={(part, minute) => {
                  document.querySelector(`[data-minute="${minute}"]`)?.scrollIntoView({ block: 'center' });
                  if (canPlay(part)) playAt(part, minute * 60);
                }}
              />
            )
          }
          kind={kind}
          lines={lines}
          status={status}
          editable={editable}
          people={people}
          nameOf={nameOf}
          avatarOf={avatarOf}
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
          linksFor={linksFor}
          scriptureSite={scriptureSite}
          onLink={saveLink}
          onUnlink={removeLink}
          documents={documents}
          around={around}
          officialAt={
            // The official video's times are lined up with a single-part recording's.
            isTimed(official) && (data.parts || []).length <= 1
              ? (_part, seconds) => videoAt(official, seconds)
              : undefined
          }
          onClip={(part, from, to, text) =>
            setClipDraft({ part, from, to, title: text.length > 60 ? `${text.slice(0, 57)}…` : text })
          }
        />
      </div>
    </article>
  );
}
