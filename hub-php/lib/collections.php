<?php
// Who may write each collection and how changes are reconciled; mirrors src/sync/collections.js.
const COLLECTIONS = [
  'sources' => ['writers' => ['editor'], 'mode' => 'mutable'],
  'schedules' => ['writers' => ['editor'], 'mode' => 'mutable'],
  'recorders' => ['writers' => ['recorder'], 'mode' => 'mutable'],
  'recordings' => ['writers' => ['recorder', 'editor'], 'mode' => 'mutable'],
  'transcript_chunks' => ['writers' => ['recorder'], 'mode' => 'immutable'],
  'stills' => ['writers' => ['recorder'], 'mode' => 'immutable'],
  'media' => ['writers' => ['recorder', 'editor'], 'mode' => 'mutable'],
  'marks' => ['writers' => ['editor', 'recorder'], 'mode' => 'mutable'],
  'settings' => ['writers' => ['editor'], 'mode' => 'mutable'],
  'publications' => ['writers' => ['editor', 'recorder'], 'mode' => 'mutable'],
  'jobs' => ['writers' => ['editor', 'recorder'], 'mode' => 'mutable'],
  'directory' => ['writers' => ['editor'], 'mode' => 'mutable'],
  'organizations' => ['writers' => ['editor'], 'mode' => 'mutable'],
  'bodies' => ['writers' => ['editor'], 'mode' => 'mutable'],
  'terms' => ['writers' => ['editor'], 'mode' => 'mutable'],
];
const MAX_RECORD_BYTES = 262144;
