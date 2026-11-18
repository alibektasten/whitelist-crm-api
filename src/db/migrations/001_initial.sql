CREATE TABLE managers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0)
) STRICT;

INSERT INTO managers (id, name) VALUES (1, 'Демо-менеджер 1'), (2, 'Демо-менеджер 2');

CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  bin TEXT NOT NULL UNIQUE CHECK(length(bin) = 12 AND bin NOT GLOB '*[^0-9]*'),
  phone TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE meetings (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  manager_id INTEGER NOT NULL REFERENCES managers(id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK(ends_at = starts_at + 3600000),
  original_starts_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- "Active" means scheduled: one such meeting per company, regardless of manager/date.
CREATE UNIQUE INDEX one_active_meeting_per_company ON meetings(company_id)
  WHERE status = 'scheduled';
CREATE INDEX manager_schedule ON meetings(manager_id, starts_at, ends_at)
  WHERE status = 'scheduled';

-- Database protection also applies to writers that bypass the HTTP/service layer.
CREATE TRIGGER meetings_no_overlap_insert BEFORE INSERT ON meetings
WHEN NEW.status = 'scheduled' AND EXISTS (
  SELECT 1 FROM meetings WHERE manager_id = NEW.manager_id AND status = 'scheduled'
    AND starts_at < NEW.ends_at AND ends_at > NEW.starts_at
)
BEGIN SELECT RAISE(ABORT, 'manager_overlap'); END;

CREATE TRIGGER meetings_no_overlap_update BEFORE UPDATE ON meetings
WHEN NEW.status = 'scheduled' AND EXISTS (
  SELECT 1 FROM meetings WHERE manager_id = NEW.manager_id AND status = 'scheduled'
    AND id != NEW.id AND starts_at < NEW.ends_at AND ends_at > NEW.starts_at
)
BEGIN SELECT RAISE(ABORT, 'manager_overlap'); END;

CREATE TRIGGER meetings_keep_identity BEFORE UPDATE ON meetings
WHEN NEW.original_starts_at != OLD.original_starts_at OR NEW.created_at != OLD.created_at
  OR NEW.company_id != OLD.company_id OR NEW.manager_id != OLD.manager_id
BEGIN SELECT RAISE(ABORT, 'immutable_meeting_identity'); END;

CREATE TABLE meeting_history (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  action TEXT NOT NULL CHECK(action IN ('created', 'rescheduled', 'cancelled')),
  previous_starts_at INTEGER,
  next_starts_at INTEGER,
  changed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX meeting_history_order ON meeting_history(meeting_id, id);

CREATE TRIGGER meetings_record_creation AFTER INSERT ON meetings
BEGIN
  INSERT INTO meeting_history(meeting_id, action, next_starts_at, changed_at)
  VALUES (NEW.id, 'created', NEW.starts_at, NEW.created_at);
END;

CREATE TRIGGER meetings_record_change AFTER UPDATE ON meetings
WHEN OLD.starts_at != NEW.starts_at OR OLD.status != NEW.status
BEGIN
  INSERT INTO meeting_history(meeting_id, action, previous_starts_at, next_starts_at, changed_at)
  VALUES (NEW.id, CASE WHEN NEW.status = 'cancelled' THEN 'cancelled' ELSE 'rescheduled' END,
    OLD.starts_at, CASE WHEN NEW.status = 'cancelled' THEN NULL ELSE NEW.starts_at END, NEW.updated_at);
END;

CREATE TABLE calls (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  result TEXT NOT NULL CHECK(result IN ('no_answer', 'refused', 'meeting_set')),
  meeting_id INTEGER REFERENCES meetings(id),
  notes TEXT,
  created_at INTEGER NOT NULL,
  CHECK((result = 'meeting_set' AND meeting_id IS NOT NULL)
     OR (result != 'meeting_set' AND meeting_id IS NULL))
) STRICT;
CREATE INDEX company_latest_call ON calls(company_id, id DESC);

CREATE TRIGGER calls_require_meeting BEFORE INSERT ON calls
WHEN NEW.result = 'meeting_set' AND NOT EXISTS (
  SELECT 1 FROM meetings WHERE id = NEW.meeting_id AND company_id = NEW.company_id AND status = 'scheduled'
)
BEGIN SELECT RAISE(ABORT, 'meeting_required'); END;
