-- PreVisit Desk v2: multi-role platform (docs/v2/contract.md). Additive on 0001, which is already applied in production.
-- Every row that belongs to a patient cascades from accounts (patient_id); visit children cascade from visits.

-- ---------------------------------------------------------------------------
-- Accounts and sessions
-- ---------------------------------------------------------------------------
ALTER TABLE accounts DROP CONSTRAINT accounts_role_check;
UPDATE accounts SET role = 'physician' WHERE role = 'clinician';

ALTER TABLE accounts
    ALTER COLUMN role SET DEFAULT 'patient',
    ALTER COLUMN username DROP NOT NULL,       -- guests and demo panel patients cannot sign in with a password
    ALTER COLUMN password_hash DROP NOT NULL,
    ADD CONSTRAINT accounts_role_check CHECK (role IN ('patient', 'physician', 'pharmacist', 'coordinator', 'admin')),
    ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    ADD COLUMN display_name_en text,
    ADD COLUMN title text,
    ADD COLUMN title_en text,
    ADD COLUMN avatar text,
    ADD COLUMN locale text NOT NULL DEFAULT 'zh-TW' CHECK (locale IN ('zh-TW', 'en')),
    ADD COLUMN preferences jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(preferences) = 'object'),
    ADD COLUMN is_guest boolean NOT NULL DEFAULT false,
    ADD COLUMN is_demo boolean NOT NULL DEFAULT false,
    -- lin, chang or wu for a guest sandbox; the key of the demo record for seeded accounts.
    ADD COLUMN demo_key text,
    ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
    ADD COLUMN last_login_at timestamptz,
    ADD COLUMN created_by uuid REFERENCES accounts (id) ON DELETE SET NULL,
    -- Guest sandboxes only: the sweep deletes the account (and everything it owns) after this time.
    ADD COLUMN expires_at timestamptz,
    ADD CONSTRAINT accounts_guest_check CHECK (NOT is_guest OR role = 'patient');

CREATE UNIQUE INDEX accounts_username_lower_idx ON accounts (lower(username)) WHERE username IS NOT NULL;
CREATE INDEX accounts_role_idx ON accounts (role, status);
CREATE INDEX accounts_expires_idx ON accounts (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX accounts_demo_idx ON accounts (demo_key) WHERE is_demo;

ALTER TABLE sessions
    ADD COLUMN id uuid NOT NULL DEFAULT uuidv7(),
    ADD COLUMN device text NOT NULL DEFAULT '',
    ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX sessions_id_idx ON sessions (id);
CREATE INDEX sessions_account_idx ON sessions (account_id);

-- ---------------------------------------------------------------------------
-- Pharmacies (fictional) and the patient record
-- ---------------------------------------------------------------------------
CREATE TABLE pharmacies (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    name_en     text NOT NULL,
    district    text NOT NULL,
    district_en text NOT NULL,
    address     text NOT NULL,
    address_en  text NOT NULL,
    hours       text NOT NULL,
    hours_en    text NOT NULL,
    services    jsonb NOT NULL DEFAULT '[]'::jsonb,
    services_en jsonb NOT NULL DEFAULT '[]'::jsonb,
    position    integer NOT NULL DEFAULT 0
);

-- conditions, medications, allergies, family_history: ProfileItem[]
CREATE TABLE patient_profiles (
    account_id            uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    revision              integer NOT NULL DEFAULT 1,
    birth_year            integer CHECK (birth_year BETWEEN 1900 AND 2100),
    sex                   text CHECK (sex IN ('female', 'male', 'other')),
    height_cm             double precision CHECK (height_cm BETWEEN 30 AND 260),
    conditions            jsonb NOT NULL DEFAULT '[]'::jsonb,
    medications           jsonb NOT NULL DEFAULT '[]'::jsonb,
    allergies             jsonb NOT NULL DEFAULT '[]'::jsonb,
    family_history        jsonb NOT NULL DEFAULT '[]'::jsonb,
    lifestyle             jsonb NOT NULL DEFAULT '{}'::jsonb,
    preferred_pharmacy_id text REFERENCES pharmacies (id) ON DELETE SET NULL,
    contact_preference    text NOT NULL DEFAULT 'in_app' CHECK (contact_preference IN ('in_app')),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

-- What the clinic manages about a patient; the patient never edits it.
CREATE TABLE patient_care (
    account_id      uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    tags            text[] NOT NULL DEFAULT '{}',
    care_status     text NOT NULL DEFAULT 'new' CHECK (care_status IN ('new', 'active', 'watch', 'inactive')),
    physician_id    uuid REFERENCES accounts (id) ON DELETE SET NULL,
    coordinator_id  uuid REFERENCES accounts (id) ON DELETE SET NULL,
    last_contact_at timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_care_physician_idx ON patient_care (physician_id);
CREATE INDEX patient_care_coordinator_idx ON patient_care (coordinator_id);

CREATE TABLE measurements (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    patient_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN ('bp', 'glucose', 'weight', 'pulse', 'lab')),
    "values"    jsonb NOT NULL CHECK (jsonb_typeof("values") = 'object'),
    taken_at    timestamptz NOT NULL,
    source      text NOT NULL DEFAULT 'patient' CHECK (source IN ('patient', 'clinic')),
    recorded_by uuid REFERENCES accounts (id) ON DELETE SET NULL,
    is_demo     boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX measurements_patient_idx ON measurements (patient_id, kind, taken_at DESC);

CREATE TABLE consents (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    doc        text NOT NULL CHECK (doc IN ('terms', 'ai_disclosure', 'rx_review')),
    version    text NOT NULL,
    granted    boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX consents_account_idx ON consents (account_id, doc, created_at DESC);

CREATE TABLE staff_notes (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    patient_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    author_id  uuid REFERENCES accounts (id) ON DELETE SET NULL,
    body       text NOT NULL,
    pinned     boolean NOT NULL DEFAULT false,
    is_demo    boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_notes_patient_idx ON staff_notes (patient_id, created_at DESC);

CREATE TABLE contact_log (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    patient_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    author_id  uuid REFERENCES accounts (id) ON DELETE SET NULL,
    channel    text NOT NULL CHECK (channel IN ('in_app', 'phone_note')),
    body       text NOT NULL,
    visit_id   uuid REFERENCES visits (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX contact_log_patient_idx ON contact_log (patient_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Who read what, who changed what
-- ---------------------------------------------------------------------------
-- One row per read of a patient's data by staff. The actor's name and role are kept as they were at that moment.
CREATE TABLE access_log (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor_id    uuid REFERENCES accounts (id) ON DELETE SET NULL,
    actor_name  text NOT NULL,
    actor_role  text NOT NULL,
    patient_id  uuid REFERENCES accounts (id) ON DELETE CASCADE,
    action      text NOT NULL,
    resource    text NOT NULL,
    resource_id text NOT NULL DEFAULT ''
);
CREATE INDEX access_log_patient_idx ON access_log (patient_id, at DESC);
CREATE INDEX access_log_actor_idx ON access_log (actor_id, at DESC);
CREATE INDEX access_log_at_idx ON access_log (at DESC);

-- Never holds message text, passwords or tokens; detail carries changed keys and ids only.
CREATE TABLE audit_log (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor_id   uuid REFERENCES accounts (id) ON DELETE SET NULL,
    actor_name text NOT NULL DEFAULT '',
    actor_role text NOT NULL DEFAULT '',
    kind       text NOT NULL CHECK (kind IN ('admin', 'rx', 'auth', 'clinic')),
    action     text NOT NULL,
    target     text NOT NULL DEFAULT '',
    detail     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, at DESC);

-- ---------------------------------------------------------------------------
-- Schedule and appointments
-- ---------------------------------------------------------------------------
-- Slots are computed from these weekly templates (Taipei time); only booked ones become rows.
CREATE TABLE schedule_templates (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    physician_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    weekday       smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),  -- ISO, Monday = 1
    starts        time NOT NULL,
    ends          time NOT NULL,
    minutes       integer NOT NULL CHECK (minutes BETWEEN 5 AND 120),
    department    text NOT NULL,
    department_en text NOT NULL,
    mode          text NOT NULL CHECK (mode IN ('in_person', 'video')),
    room          text,
    CHECK (ends > starts)
);
CREATE INDEX schedule_templates_physician_idx ON schedule_templates (physician_id, weekday);

CREATE TABLE appointments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    physician_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    department    text NOT NULL,
    department_en text NOT NULL DEFAULT '',
    starts_at     timestamptz NOT NULL,
    minutes       integer NOT NULL DEFAULT 15 CHECK (minutes BETWEEN 5 AND 120),
    mode          text NOT NULL DEFAULT 'in_person' CHECK (mode IN ('in_person', 'video')),
    status        text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'checked_in', 'completed', 'cancelled')),
    reason        text,
    room          text,
    reminded_at   timestamptz,
    is_demo       boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
-- One live booking per physician and start time: two patients cannot take the same slot.
CREATE UNIQUE INDEX appointments_slot_idx ON appointments (physician_id, starts_at) WHERE status <> 'cancelled';
CREATE INDEX appointments_patient_idx ON appointments (patient_id, starts_at);
CREATE INDEX appointments_starts_idx ON appointments (starts_at);

-- ---------------------------------------------------------------------------
-- Visits: owner, thread mode, event log
-- ---------------------------------------------------------------------------
ALTER TABLE visits
    ADD COLUMN patient_id uuid REFERENCES accounts (id) ON DELETE CASCADE,   -- NULL: a v1 visit, staff only
    ADD COLUMN appointment_id uuid REFERENCES appointments (id) ON DELETE SET NULL,
    ADD COLUMN title text,
    ADD COLUMN title_custom boolean NOT NULL DEFAULT false,
    ADD COLUMN pinned boolean NOT NULL DEFAULT false,
    ADD COLUMN archived boolean NOT NULL DEFAULT false,
    ADD COLUMN mode text NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai', 'human')),
    ADD COLUMN assigned_to uuid REFERENCES accounts (id) ON DELETE SET NULL,
    ADD COLUMN reviewed_by_id uuid REFERENCES accounts (id) ON DELETE SET NULL,
    ADD COLUMN last_seq bigint NOT NULL DEFAULT 0,
    -- Bumped on every intake or summary change; PrevisitSummary.revision.
    ADD COLUMN summary_revision integer NOT NULL DEFAULT 0,
    ADD COLUMN edited_by_patient boolean NOT NULL DEFAULT false,
    -- Field key -> message ids the value came from.
    ADD COLUMN evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
UPDATE visits v SET reviewed_by_id = a.id FROM accounts a WHERE v.reviewed_by IS NOT NULL AND a.display_name = v.reviewed_by;
CREATE INDEX visits_patient_idx ON visits (patient_id, last_activity_at DESC);
CREATE INDEX visits_assigned_idx ON visits (assigned_to) WHERE assigned_to IS NOT NULL;
CREATE UNIQUE INDEX visits_appointment_idx ON visits (appointment_id) WHERE appointment_id IS NOT NULL;

ALTER TABLE messages DROP CONSTRAINT messages_role_check;
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages
    ADD CONSTRAINT messages_role_check CHECK (role IN ('patient', 'assistant', 'staff')),
    ADD CONSTRAINT messages_kind_check CHECK (kind IN ('opening', 'chat', 'red_flag', 'refusal', 'notice', 'handoff')),
    ADD COLUMN seq bigint NOT NULL DEFAULT 0,
    ADD COLUMN client_id text CHECK (length(client_id) BETWEEN 1 AND 64),
    ADD COLUMN author_id uuid REFERENCES accounts (id) ON DELETE SET NULL,
    ADD COLUMN status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'interrupted'));
CREATE UNIQUE INDEX messages_client_idx ON messages (visit_id, client_id) WHERE client_id IS NOT NULL;

ALTER TABLE runs DROP CONSTRAINT runs_status_check;
ALTER TABLE runs
    ADD CONSTRAINT runs_status_check CHECK (status IN ('running', 'completed', 'failed', 'skipped', 'interrupted')),
    ADD COLUMN message_id uuid REFERENCES messages (id) ON DELETE SET NULL,
    ADD COLUMN cost_usd double precision NOT NULL DEFAULT 0;
CREATE INDEX runs_created_idx ON runs (created_at DESC);
CREATE INDEX runs_running_idx ON runs (visit_id) WHERE status = 'running';

-- The durable event stream of a visit. visibility = 'staff' rows are skipped for the patient.
CREATE TABLE visit_events (
    visit_id   uuid NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
    seq        bigint NOT NULL,
    type       text NOT NULL,
    data       jsonb NOT NULL,
    visibility text NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'staff')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (visit_id, seq)
);

-- Per-account read position, for has_unread.
CREATE TABLE visit_reads (
    visit_id   uuid NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    seq        bigint NOT NULL DEFAULT 0,
    read_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (visit_id, account_id)
);
CREATE INDEX visit_reads_account_idx ON visit_reads (account_id);

-- ---------------------------------------------------------------------------
-- Clinical notes
-- ---------------------------------------------------------------------------
-- sections: {subjective, objective, assessment, plan, patient_message}
CREATE TABLE clinical_notes (
    visit_id   uuid PRIMARY KEY REFERENCES visits (id) ON DELETE CASCADE,
    revision   integer NOT NULL DEFAULT 1,
    version    integer NOT NULL DEFAULT 1,
    status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed')),
    sections   jsonb NOT NULL,
    author_id  uuid REFERENCES accounts (id) ON DELETE SET NULL,
    signed_by  uuid REFERENCES accounts (id) ON DELETE SET NULL,
    signed_at  timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'signed') = (signed_at IS NOT NULL))
);

CREATE TABLE note_versions (
    visit_id uuid NOT NULL REFERENCES clinical_notes (visit_id) ON DELETE CASCADE,
    version  integer NOT NULL,
    sections jsonb NOT NULL,
    by_id    uuid REFERENCES accounts (id) ON DELETE SET NULL,
    at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (visit_id, version)
);

CREATE TABLE note_addenda (
    id       uuid PRIMARY KEY DEFAULT uuidv7(),
    visit_id uuid NOT NULL REFERENCES clinical_notes (visit_id) ON DELETE CASCADE,
    body     text NOT NULL,
    by_id    uuid REFERENCES accounts (id) ON DELETE SET NULL,
    at       timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX note_addenda_visit_idx ON note_addenda (visit_id, at);

-- ---------------------------------------------------------------------------
-- Account-level state
-- ---------------------------------------------------------------------------
CREATE TABLE drafts (
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    scope      text NOT NULL CHECK (length(scope) BETWEEN 1 AND 120),
    payload    jsonb NOT NULL,
    revision   integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, scope)
);
CREATE INDEX drafts_updated_idx ON drafts (updated_at);

-- Title and body are rendered from kind and params in the reader's language.
CREATE TABLE notifications (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    kind       text NOT NULL,
    params     jsonb NOT NULL DEFAULT '{}'::jsonb,
    link       text,
    dedupe_key text,
    read_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX notifications_account_idx ON notifications (account_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (account_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications (account_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE idempotency_keys (
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    key        text NOT NULL CHECK (length(key) BETWEEN 1 AND 100),
    route      text NOT NULL,
    status     smallint,          -- NULL while the first request is still running
    response   jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE TABLE app_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    revision   integer NOT NULL DEFAULT 1,
    updated_by uuid REFERENCES accounts (id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE usage_daily ADD COLUMN cost_usd double precision NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Medicines and rx requests (written by backend/src/rx)
-- ---------------------------------------------------------------------------
-- The drug's names and class are copied from the formulary at the time of writing, so a formulary edit never
-- changes an old record. self_reported rows have no dates and can never be refilled.
CREATE TABLE prescriptions (
    id               uuid PRIMARY KEY DEFAULT uuidv7(),
    patient_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    source           text NOT NULL DEFAULT 'clinic' CHECK (source IN ('clinic', 'self_reported')),
    drug_id          text,
    name_zh          text NOT NULL,
    name_en          text NOT NULL DEFAULT '',
    class_id         text NOT NULL DEFAULT '',
    class_zh         text NOT NULL DEFAULT '',
    class_en         text NOT NULL DEFAULT '',
    controlled_level smallint NOT NULL DEFAULT 0 CHECK (controlled_level BETWEEN 0 AND 4),
    dose_text        text NOT NULL DEFAULT '',
    dose_text_en     text NOT NULL DEFAULT '',
    issued_on        date,
    total_days       integer CHECK (total_days > 0),
    days_per_fill    integer CHECK (days_per_fill > 0),
    fills_allowed    integer CHECK (fills_allowed BETWEEN 1 AND 12),
    valid_until      date,
    prescriber_id    uuid REFERENCES accounts (id) ON DELETE SET NULL,
    -- Set when a dispensed renewal created this record (a demonstration record, not a real prescription).
    renewed_from     uuid REFERENCES prescriptions (id) ON DELETE SET NULL,
    rx_request_id    uuid,
    active           boolean NOT NULL DEFAULT true,
    is_demo          boolean NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (source = 'self_reported' OR (issued_on IS NOT NULL AND total_days IS NOT NULL AND days_per_fill IS NOT NULL AND fills_allowed IS NOT NULL AND valid_until IS NOT NULL))
);
CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, active, issued_on DESC);
CREATE INDEX prescriptions_class_idx ON prescriptions (class_id);

CREATE TABLE fills (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    prescription_id uuid NOT NULL REFERENCES prescriptions (id) ON DELETE CASCADE,
    n               integer NOT NULL CHECK (n >= 1),
    filled_on       date NOT NULL,
    pharmacy_id     text REFERENCES pharmacies (id) ON DELETE SET NULL,
    pharmacy_name   text NOT NULL DEFAULT '',
    dispensed_by    uuid REFERENCES accounts (id) ON DELETE SET NULL,
    rx_request_id   uuid,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (prescription_id, n)
);

-- RX-YYYYMMDD-NNNN: one counter row per Taipei day, bumped atomically.
CREATE TABLE rx_counters (
    day date PRIMARY KEY,
    n   integer NOT NULL
);

CREATE TABLE rx_requests (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    no                  text NOT NULL UNIQUE,
    kind                text NOT NULL CHECK (kind IN ('refill', 'renewal')),
    status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'in_review', 'more_info', 'approved', 'partially_approved', 'declined', 'visit_required', 'at_pharmacy', 'returned', 'ready', 'dispensed', 'cancelled')),
    revision            integer NOT NULL DEFAULT 1,
    patient_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    locale              text NOT NULL DEFAULT 'zh-TW' CHECK (locale IN ('zh-TW', 'en')),
    step                text NOT NULL DEFAULT '',
    answers             jsonb NOT NULL DEFAULT '{}'::jsonb,
    monitoring          jsonb NOT NULL DEFAULT '{}'::jsonb,
    engine              jsonb,
    disposition         text CHECK (disposition IN ('ready', 'review', 'in_person', 'urgent', 'excluded')),
    protocol_version    text,
    consent_version     text,
    pharmacy_id         text REFERENCES pharmacies (id) ON DELETE SET NULL,
    pickup_window       jsonb,
    pharmacy_checks     jsonb NOT NULL DEFAULT '{}'::jsonb,
    assigned_to         uuid REFERENCES accounts (id) ON DELETE SET NULL,
    priority            text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'soon', 'urgent')),
    sla_due_at          timestamptz,
    overdue_notified_at timestamptz,
    decision_note       text,       -- staff only
    patient_message     text,
    decided_by          uuid REFERENCES accounts (id) ON DELETE SET NULL,
    extra               jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_demo             boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    submitted_at        timestamptz,
    decided_at          timestamptz,
    ready_at            timestamptz,
    closed_at           timestamptz,
    updated_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX rx_requests_patient_idx ON rx_requests (patient_id, updated_at DESC);
CREATE INDEX rx_requests_status_idx ON rx_requests (status, priority, sla_due_at);
CREATE INDEX rx_requests_assigned_idx ON rx_requests (assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX rx_requests_submitted_idx ON rx_requests (submitted_at);

CREATE TABLE rx_request_items (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    request_id      uuid NOT NULL REFERENCES rx_requests (id) ON DELETE CASCADE,
    prescription_id uuid NOT NULL REFERENCES prescriptions (id) ON DELETE CASCADE,
    position        integer NOT NULL DEFAULT 0,
    class_id        text NOT NULL DEFAULT '',
    scope           text NOT NULL DEFAULT 'in_scope' CHECK (scope IN ('in_scope', 'physician_only', 'excluded')),
    scope_reason    text NOT NULL DEFAULT '',
    engine          jsonb,
    disposition     text CHECK (disposition IN ('ready', 'review', 'in_person', 'urgent', 'excluded')),
    refill          jsonb,
    outcome         text CHECK (outcome IN ('approve', 'decline', 'visit_required', 'more_info')),
    outcome_note    text,
    decided_by      uuid REFERENCES accounts (id) ON DELETE SET NULL,
    decided_at      timestamptz,
    UNIQUE (request_id, prescription_id)
);
CREATE INDEX rx_request_items_prescription_idx ON rx_request_items (prescription_id);
CREATE INDEX rx_request_items_class_idx ON rx_request_items (class_id);

-- The timeline. data holds parameters; the text is rendered in the reader's language.
CREATE TABLE rx_events (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    request_id  uuid NOT NULL REFERENCES rx_requests (id) ON DELETE CASCADE,
    at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    type        text NOT NULL,
    actor_id    uuid REFERENCES accounts (id) ON DELETE SET NULL,
    from_status text,
    to_status   text,
    data        jsonb NOT NULL DEFAULT '{}'::jsonb,
    visibility  text NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'staff'))
);
CREATE INDEX rx_events_request_idx ON rx_events (request_id, at);
CREATE INDEX rx_events_at_idx ON rx_events (at);

CREATE TABLE rx_messages (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    request_id uuid NOT NULL REFERENCES rx_requests (id) ON DELETE CASCADE,
    author_id  uuid REFERENCES accounts (id) ON DELETE SET NULL,
    body       text NOT NULL,
    visibility text NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'staff')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX rx_messages_request_idx ON rx_messages (request_id, created_at);

-- Per-account read time, for RxRequestBrief.unread.
CREATE TABLE rx_reads (
    request_id uuid NOT NULL REFERENCES rx_requests (id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    read_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (request_id, account_id)
);

ALTER TABLE prescriptions
    ADD CONSTRAINT prescriptions_rx_request_fk FOREIGN KEY (rx_request_id) REFERENCES rx_requests (id) ON DELETE SET NULL;
ALTER TABLE fills
    ADD CONSTRAINT fills_rx_request_fk FOREIGN KEY (rx_request_id) REFERENCES rx_requests (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Tickets can now come from an rx request as well as from a visit
-- ---------------------------------------------------------------------------
ALTER TABLE clinician_tickets
    ALTER COLUMN visit_id DROP NOT NULL,
    ADD COLUMN patient_id uuid REFERENCES accounts (id) ON DELETE CASCADE,
    ADD COLUMN rx_request_id uuid REFERENCES rx_requests (id) ON DELETE CASCADE,
    ADD COLUMN resolved_by_id uuid REFERENCES accounts (id) ON DELETE SET NULL,
    ADD CONSTRAINT clinician_tickets_source_check CHECK (visit_id IS NOT NULL OR rx_request_id IS NOT NULL);
CREATE INDEX clinician_tickets_rx_idx ON clinician_tickets (rx_request_id) WHERE rx_request_id IS NOT NULL;
CREATE INDEX clinician_tickets_patient_idx ON clinician_tickets (patient_id) WHERE patient_id IS NOT NULL;
