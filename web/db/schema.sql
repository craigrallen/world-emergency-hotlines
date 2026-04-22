-- D1 schema for World Emergency & Hotlines
-- Compatible with Cloudflare D1 (SQLite). Storage of multi-valued fields
-- (voice_numbers, sources, languages, …) uses JSON TEXT columns — parse at
-- read-time in the data adapter.

PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS intake_leads;
DROP TABLE IF EXISTS hotlines;
DROP TABLE IF EXISTS countries;

CREATE TABLE countries (
  alpha2            TEXT PRIMARY KEY,
  alpha3            TEXT NOT NULL,
  name              TEXT NOT NULL,
  region            TEXT,
  subregion         TEXT,
  general_emergency TEXT NOT NULL DEFAULT '[]',  -- JSON array
  notes             TEXT,
  centroid_lat      REAL,
  centroid_lng      REAL,
  last_reviewed     DATE,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE hotlines (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  country_code        TEXT NOT NULL REFERENCES countries(alpha2) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  organization        TEXT,
  category            TEXT NOT NULL,
  voice_numbers       TEXT NOT NULL DEFAULT '[]',
  sms_numbers         TEXT NOT NULL DEFAULT '[]',
  text_numbers        TEXT NOT NULL DEFAULT '[]',
  short_codes         TEXT NOT NULL DEFAULT '[]',
  chat_url            TEXT,
  email               TEXT,
  website             TEXT,
  hours               TEXT,
  languages           TEXT NOT NULL DEFAULT '[]',
  cost                TEXT NOT NULL DEFAULT 'unknown',
  target              TEXT,
  geography           TEXT,
  notes               TEXT,
  verification_status TEXT NOT NULL DEFAULT 'legacy_unverified',
  last_verified       DATE,
  sources             TEXT NOT NULL DEFAULT '[]',
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_hotlines_country   ON hotlines(country_code);
CREATE INDEX idx_hotlines_category  ON hotlines(category);
CREATE INDEX idx_hotlines_verified  ON hotlines(verification_status);

-- Intake queue — the Python canonicalization pipeline is the promotion gate.
-- Anything submitted via an edge form lands here as 'pending'.
CREATE TABLE intake_leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  country_code  TEXT,
  payload       TEXT NOT NULL,           -- full hotline JSON as supplied
  source        TEXT NOT NULL,           -- 'web_form' | 'external_feed' | ...
  submitted_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  status        TEXT NOT NULL DEFAULT 'pending',
  review_notes  TEXT
);

CREATE INDEX idx_intake_status ON intake_leads(status, submitted_at);
