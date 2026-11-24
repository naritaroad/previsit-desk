-- PreVisit Desk: one clean schema. No IP addresses and no patient name fields are stored.
-- Every visit child table cascades from visits, so the retention sweep is a single DELETE.

CREATE TABLE accounts (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    username      text NOT NULL UNIQUE,
    display_name  text NOT NULL,
    password_hash text NOT NULL,
    role          text NOT NULL DEFAULT 'clinician' CHECK (role IN ('clinician')),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    token_hash bytea PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- The visit id doubles as the patient's access credential, so it must be unguessable (v4).
CREATE TABLE visits (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    locale           text NOT NULL CHECK (locale IN ('zh-TW', 'en')),
    status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'red_flag', 'submitted', 'reviewed')),
    stage            text NOT NULL DEFAULT 'chief_complaint' CHECK (stage IN ('chief_complaint', 'hpi', 'background', 'confirm', 'done')),
    intake           jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    last_activity_at timestamptz NOT NULL DEFAULT now(),
    submitted_at     timestamptz,
    reviewed_at      timestamptz,
    reviewed_by      text,
    review_note      text,
    -- Set when an assistant reply was produced while the stage was `confirm` (the read-back); cleared when the intake changes.
    confirm_offered_at timestamptz
);
CREATE INDEX visits_status_activity_idx ON visits (status, last_activity_at DESC);
CREATE INDEX visits_activity_idx ON visits (last_activity_at);

-- clock_timestamp() (not now()) so rows written in one transaction still sort in insertion order.
CREATE TABLE messages (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    visit_id   uuid NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
    role       text NOT NULL CHECK (role IN ('patient', 'assistant')),
    kind       text NOT NULL CHECK (kind IN ('opening', 'chat', 'red_flag', 'refusal', 'notice')),
    content    text NOT NULL,
    run_id     uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX messages_visit_idx ON messages (visit_id, created_at);

CREATE TABLE runs (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    visit_id      uuid NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
    model         text NOT NULL,
    fallback_used boolean NOT NULL DEFAULT false,
    status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
    steps         integer NOT NULL DEFAULT 0,
    input_tokens  integer NOT NULL DEFAULT 0,
    output_tokens integer NOT NULL DEFAULT 0,
    error_code    text,
    duration_ms   integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX runs_visit_idx ON runs (visit_id, created_at);

CREATE TABLE tool_calls (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    visit_id    uuid NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
    run_id      uuid,
    step        integer NOT NULL DEFAULT 0,
    name        text NOT NULL,
    source      text NOT NULL CHECK (source IN ('code', 'model', 'form')),
    status      text NOT NULL CHECK (status IN ('ok', 'rejected', 'error')),
    arguments   jsonb NOT NULL DEFAULT '{}'::jsonb,
    result      jsonb NOT NULL DEFAULT '{}'::jsonb,
    duration_ms integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tool_calls_visit_idx ON tool_calls (visit_id, created_at);

CREATE TABLE red_flag_events (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    visit_id   uuid NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
    message_id uuid NOT NULL,
    category   text NOT NULL,
    rule_id    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX red_flag_events_visit_idx ON red_flag_events (visit_id, created_at);

CREATE TABLE guard_events (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    visit_id   uuid NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
    run_id     uuid,
    kind       text NOT NULL,
    action     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX guard_events_visit_idx ON guard_events (visit_id, created_at);

CREATE TABLE previsit_summaries (
    visit_id     uuid PRIMARY KEY REFERENCES visits (id) ON DELETE CASCADE,
    content      jsonb NOT NULL,
    generated_by text NOT NULL CHECK (generated_by IN ('model', 'code')),
    model        text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Ticket numbers T-YYYYMMDD-NNNN: one counter row per Taipei day, bumped atomically.
CREATE TABLE ticket_counters (
    day date PRIMARY KEY,
    n   integer NOT NULL
);

CREATE TABLE clinician_tickets (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    ticket_no       text NOT NULL UNIQUE,
    visit_id        uuid NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
    reason          text NOT NULL,
    urgency         text NOT NULL CHECK (urgency IN ('routine', 'soon', 'urgent')),
    summary         text NOT NULL,
    status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_by      text NOT NULL CHECK (created_by IN ('model', 'code', 'form')),
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    resolved_at     timestamptz,
    resolved_by     text,
    resolution_note text
);
CREATE INDEX clinician_tickets_status_idx ON clinician_tickets (status, urgency);
CREATE INDEX clinician_tickets_visit_idx ON clinician_tickets (visit_id, created_at);

CREATE TABLE refill_checks (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    visit_id   uuid NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
    input      jsonb NOT NULL,
    result     jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX refill_checks_visit_idx ON refill_checks (visit_id, created_at);

-- Model call counts per Taipei day and model; the daily cap reads this table.
CREATE TABLE usage_daily (
    day           date NOT NULL,
    model         text NOT NULL,
    calls         integer NOT NULL DEFAULT 0,
    input_tokens  bigint NOT NULL DEFAULT 0,
    output_tokens bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (day, model)
);
