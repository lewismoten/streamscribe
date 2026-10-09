// Tasks for agents to run on a meeting's transcript with a language model (an Ollama server an agent is set up to use;
// see src/recorder/prompts.js): each a prompt with {{placeholders}} for the meeting, kept in the hub's `prompts`
// collection, run from a meeting's page (or after each meeting, when `auto`), its result kept in `prompt_results`.
// Shared by the web app and agents.
//
// Placeholders: {{title}} {{date}} {{body}} the meeting; {{transcript}} its lines ([time] Speaker (role): words);
// {{chapters}} its agenda items with times; {{votes}} motions and how each member voted; {{speakers}} who spoke and
// for how long; {{stills}} the times of pictures (camera changes, slides); {{official}} links to the official video
// and documents; {{pastMeetings}} other meetings of the same source (title, date, chapters).

export const PLACEHOLDERS = [
  'title',
  'date',
  'body',
  'transcript',
  'chapters',
  'votes',
  'speakers',
  'stills',
  'official',
  'pastMeetings'
];

const writer =
  'You write for local residents about their government. Be accurate and neutral; use only what is in the meeting record below, and say when something is unclear. Give times as [h:mm:ss] so readers can find each moment.';

const record = `Meeting: {{title}} ({{body}}), {{date}}

Agenda items (chapters):
{{chapters}}

Votes:
{{votes}}

Transcript:
{{transcript}}`;

export const SUGGESTED_PROMPTS = [
  {
    id: 'summary',
    name: 'Summary',
    description: 'A short summary: what was decided, discussed, and comes next.',
    prompt: `${writer}\n\nSummarize this meeting in under 300 words: the decisions made (with how members voted), the main discussions, and what comes next.\n\n${record}`
  },
  {
    id: 'minutes',
    name: 'Meeting minutes',
    description: 'Draft minutes in the usual form: attendance, each item, motions, votes.',
    prompt: `${writer}\n\nDraft minutes of this meeting in the usual form: call to order, who was present, each agenda item in order with a brief account of discussion, every motion (who moved, who seconded) and the vote, and adjournment.\n\n${record}`
  },
  {
    id: 'article',
    name: 'Article with screenshots',
    description: 'A news article, with where screenshots would go.',
    prompt: `${writer}\n\nWrite a news article (600 to 900 words) about the most newsworthy parts of this meeting, quoting speakers by name. Where a picture would help, put [Screenshot at h:mm:ss] using one of these times when pictures were taken: {{stills}}\n\n${record}`
  },
  {
    id: 'youtube',
    name: 'YouTube title, description, and chapters',
    description: 'A title, a description, and chapter markers for YouTube.',
    prompt: `${writer}\n\nWrite a YouTube title (under 100 characters), a description (2 short paragraphs, then the official links: {{official}}), and chapter markers, one per line as "h:mm:ss Title" starting at 0:00:00, from these agenda items:\n{{chapters}}\n\n${record}`
  },
  {
    id: 'blog',
    name: 'Blog post',
    description: 'A friendly blog post about the meeting.',
    prompt: `${writer}\n\nWrite a blog post (500 to 800 words) explaining this meeting to a neighbor who missed it: what happened, why it matters, and how to follow up or take part.\n\n${record}`
  },
  {
    id: 'past-meetings',
    name: 'Past meetings on the same topics',
    description: 'Which earlier meetings took up the same topics.',
    prompt: `${writer}\n\nList the main topics of this meeting. For each, name the earlier meetings below that took it up (by title and date, and the agenda item), and how this meeting continued it.\n\nEarlier meetings:\n{{pastMeetings}}\n\n${record}`
  },
  {
    id: 'topics',
    name: 'Topics, with when',
    description: 'Each topic discussed, with its times and who spoke to it (for tagging).',
    prompt: `${writer}\n\nList each topic discussed as "Topic: [h:mm:ss] who spoke (for, against, or neither)" lines, one topic per line, most discussed first.\n\n${record}`
  },
  {
    id: 'notes-links',
    name: 'Notes and links',
    description: 'Things worth a note or a link: laws cited, documents, places, numbers to check.',
    prompt: `${writer}\n\nList what in this meeting is worth a note or a link, each with its time: laws and codes cited (with their citation), documents referred to, places named, figures (dollars, votes, dates) worth checking, and claims a reader might want sourced.\n\n${record}`
  },
  {
    id: 'people-places',
    name: 'People, places, topics, and events',
    description: 'Everyone and everything named.',
    prompt: `${writer}\n\nList, under headings, the people (with their role), organizations, places, topics, and events named in this meeting, each with the first time it came up.\n\nWho spoke:\n{{speakers}}\n\n${record}`
  },
  {
    id: 'analysis',
    name: 'Analysis of the meeting',
    description: 'How well it was run, what members cared about, speakers’ backgrounds, what’s newsworthy.',
    prompt: `${writer}\n\nAnalyze this meeting:\n1. How well it was carried out (order, time kept, public comment, how motions were handled).\n2. The topics each voting member was most interested in, with examples.\n3. Background on vendors and presenters from what they said about themselves.\n4. What is most newsworthy on its own, and what continues earlier meetings:\n{{pastMeetings}}\n\nWho spoke:\n{{speakers}}\n\n${record}`
  },
  {
    id: 'public-comment-playlist',
    name: 'Playlist of public comments',
    description: 'Each public commenter, with start and end times (for a playlist of clips).',
    prompt: `${writer}\n\nList each public comment as "h:mm:ss to h:mm:ss Name: topic (for, against, or neither)", in order.\n\n${record}`
  },
  {
    id: 'questions',
    name: 'Questions to follow up',
    description: 'Open questions, promised follow-ups, and items deferred.',
    prompt: `${writer}\n\nList the open questions, the follow-ups members or staff promised (who promised what), and items deferred to a later meeting, each with its time.\n\n${record}`
  }
];

// A prompt with its placeholders filled in.
export const fillPrompt = (template, values) =>
  String(template).replace(/\{\{(\w+)\}\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name] ?? '') : whole
  );

export const resultId = (recordingId, promptId) => `${recordingId}:${promptId}`;
export const promptJobId = (recordingId, promptId) =>
  `prompt-${recordingId}-${promptId}`.replace(/[^A-Za-z0-9_-]/g, '-');
