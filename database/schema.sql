-- MITRA baseline schema (migration version 1).
-- Later changes go in database/migrations/NNN_description.sql (NNN >= 002).
-- Timestamps are UTC ISO-8601 strings; calendar dates are local YYYY-MM-DD.

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------- documents
CREATE TABLE documents (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL UNIQUE,            -- safe server-generated filename
  mime_type     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('pdf','docx','image')),
  size_bytes    INTEGER NOT NULL,
  page_count    INTEGER,
  status        TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','needs_text')),
  status_detail TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_documents_created ON documents (created_at DESC);

CREATE TABLE document_content (
  document_id INTEGER PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
  text        TEXT NOT NULL DEFAULT '',          -- pages separated by form-feed (\f) when has_pages = 1
  method      TEXT NOT NULL DEFAULT 'none' CHECK (method IN ('pdf-text','docx-text','ocr','manual','none')),
  has_pages   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ----------------------------------------------------------- conversations
CREATE TABLE conversations (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'New conversation',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_conversations_updated ON conversations (updated_at DESC);

CREATE TABLE explanations (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER REFERENCES documents (id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  mode         TEXT NOT NULL,
  source_text  TEXT NOT NULL,
  source_hash  TEXT NOT NULL,                     -- sha256(mode + source + source label), used to re-use answers
  content      TEXT NOT NULL,
  provider     TEXT,
  model        TEXT,
  saved        INTEGER NOT NULL DEFAULT 0,        -- 1 = kept even if its conversation is deleted
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_explanations_hash ON explanations (source_hash);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  mode            TEXT,
  document_id     INTEGER REFERENCES documents (id) ON DELETE SET NULL,
  source_label    TEXT,                           -- only set when document/page are really known
  origin          TEXT NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai','local','cache','user')),
  explanation_id  INTEGER REFERENCES explanations (id) ON DELETE SET NULL,
  term_id         INTEGER,                        -- dictionary entry shown by a term lookup (no FK: terms are independent)
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_messages_conversation ON messages (conversation_id, id);

CREATE TABLE ai_usage (
  id         INTEGER PRIMARY KEY,
  day        TEXT NOT NULL,                       -- local YYYY-MM-DD
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ai_usage_day ON ai_usage (day);

-- --------------------------------------------------- dictionary / vocabulary
CREATE TABLE psychology_terms (
  id               INTEGER PRIMARY KEY,
  term             TEXT NOT NULL COLLATE NOCASE UNIQUE,
  pronunciation    TEXT,
  simple_english   TEXT,
  tamil            TEXT,
  definition       TEXT,                          -- psychology-specific definition
  example          TEXT,                          -- example sentence
  everyday_example TEXT,
  related          TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
  personal_note    TEXT,                          -- the student's own explanation
  origin           TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('builtin','user','ai')),
  verified         INTEGER NOT NULL DEFAULT 0,    -- built-in entries are 1; AI entries start at 0
  saved            INTEGER NOT NULL DEFAULT 0,
  last_accessed    TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_terms_accessed ON psychology_terms (last_accessed DESC);

CREATE TABLE vocabulary (
  id             INTEGER PRIMARY KEY,
  word           TEXT NOT NULL COLLATE NOCASE UNIQUE,
  part_of_speech TEXT,
  meaning        TEXT,
  tamil          TEXT,
  psych_meaning  TEXT,
  example        TEXT,
  source_note    TEXT,
  status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','learning','needs_revision','learned')),
  term_id        INTEGER REFERENCES psychology_terms (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_reviewed  TEXT
);
CREATE INDEX idx_vocab_status ON vocabulary (status);

-- -------------------------------------------------------------------- notes
CREATE TABLE study_notes (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',           -- sanitised HTML
  plain_text  TEXT NOT NULL DEFAULT '',
  document_id INTEGER REFERENCES documents (id) ON DELETE SET NULL,
  version     INTEGER NOT NULL DEFAULT 1,         -- optimistic-concurrency counter
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_notes_updated ON study_notes (updated_at DESC);

-- ----------------------------------------------------------------- calendar
CREATE TABLE study_events (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  event_date  TEXT NOT NULL,                      -- local YYYY-MM-DD
  start_time  TEXT NOT NULL,                      -- local HH:MM
  end_time    TEXT,
  category    TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('study','revision','quiz','assignment','exam','other')),
  completed   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_events_date ON study_events (event_date, start_time);

-- --------------------------------------------------------------- flashcards
CREATE TABLE flashcards (
  id            INTEGER PRIMARY KEY,
  front         TEXT NOT NULL,
  back          TEXT NOT NULL,
  example       TEXT,
  source_note   TEXT,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','learning','needs_revision','learned')),
  step          INTEGER NOT NULL DEFAULT 0,       -- position in the fixed interval ladder
  due_date      TEXT NOT NULL,                    -- local YYYY-MM-DD
  vocabulary_id INTEGER REFERENCES vocabulary (id) ON DELETE SET NULL,
  document_id   INTEGER REFERENCES documents (id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_reviewed TEXT
);
CREATE INDEX idx_flashcards_due ON flashcards (due_date);

CREATE TABLE flashcard_reviews (
  id           INTEGER PRIMARY KEY,
  flashcard_id INTEGER NOT NULL REFERENCES flashcards (id) ON DELETE CASCADE,
  result       TEXT NOT NULL CHECK (result IN ('understood','revision')),
  reviewed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  day          TEXT NOT NULL,                     -- local YYYY-MM-DD, for activity charts
  next_due     TEXT NOT NULL
);
CREATE INDEX idx_reviews_card ON flashcard_reviews (flashcard_id);
CREATE INDEX idx_reviews_day ON flashcard_reviews (day);

-- ------------------------------------------------------------------ quizzes
CREATE TABLE quizzes (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  source_type  TEXT NOT NULL CHECK (source_type IN ('note','document','text','topic')),
  source_label TEXT,
  source_ref   INTEGER,                           -- note/document id when applicable (informational)
  provider     TEXT,
  model        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE quiz_questions (
  id          INTEGER PRIMARY KEY,
  quiz_id     INTEGER NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('mcq','tf')),
  question    TEXT NOT NULL,
  options     TEXT,                               -- JSON array for mcq
  correct     TEXT NOT NULL,                      -- mcq: option index as text; tf: 'true' | 'false'
  explanation TEXT
);
CREATE INDEX idx_questions_quiz ON quiz_questions (quiz_id, position);

CREATE TABLE quiz_attempts (
  id           INTEGER PRIMARY KEY,
  quiz_id      INTEGER NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,
  score        INTEGER,
  total        INTEGER NOT NULL,
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX idx_attempts_quiz ON quiz_attempts (quiz_id);

CREATE TABLE quiz_answers (
  id          INTEGER PRIMARY KEY,
  attempt_id  INTEGER NOT NULL REFERENCES quiz_attempts (id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES quiz_questions (id) ON DELETE CASCADE,
  answer      TEXT,
  is_correct  INTEGER NOT NULL,
  UNIQUE (attempt_id, question_id)
);

-- --------------------------------------------------------------- activity
CREATE TABLE activity_log (
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL,
  label      TEXT NOT NULL,
  ref_type   TEXT,
  ref_id     INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_activity_created ON activity_log (created_at DESC);
