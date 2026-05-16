--
-- PostgreSQL database dump
--

\restrict IIgsEoyQINLRjVmS7G4aieW8uD4E23sXJnkafFhAJUuOrrQtQFc4ILRfLcQPvh1

-- Dumped from database version 16.13 (Debian 16.13-1.pgdg12+1)
-- Dumped by pg_dump version 16.13 (Debian 16.13-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

ALTER TABLE IF EXISTS ONLY public.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_workspace_id_workspaces_id_fk;
ALTER TABLE IF EXISTS ONLY public.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_workflow_id_workflow_definitions_id_fk;
ALTER TABLE IF EXISTS ONLY public.workflow_definitions DROP CONSTRAINT IF EXISTS workflow_definitions_workspace_id_workspaces_id_fk;
ALTER TABLE IF EXISTS ONLY public.webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_webhook_id_webhooks_id_fk;
ALTER TABLE IF EXISTS ONLY public.strategic_goals DROP CONSTRAINT IF EXISTS strategic_goals_workspace_id_workspaces_id_fk;
ALTER TABLE IF EXISTS ONLY public.strategic_goals DROP CONSTRAINT IF EXISTS strategic_goals_business_id_businesses_id_fk;
ALTER TABLE IF EXISTS ONLY public.step_runs DROP CONSTRAINT IF EXISTS step_runs_run_id_workflow_runs_id_fk;
ALTER TABLE IF EXISTS ONLY public.snapshot_items DROP CONSTRAINT IF EXISTS snapshot_items_snapshot_id_snapshots_id_fk;
ALTER TABLE IF EXISTS ONLY public.rollback_results DROP CONSTRAINT IF EXISTS rollback_results_request_id_rollback_requests_id_fk;
ALTER TABLE IF EXISTS ONLY public.rollback_results DROP CONSTRAINT IF EXISTS rollback_results_item_id_snapshot_items_id_fk;
ALTER TABLE IF EXISTS ONLY public.risks DROP CONSTRAINT IF EXISTS risks_workspace_id_workspaces_id_fk;
ALTER TABLE IF EXISTS ONLY public.risks DROP CONSTRAINT IF EXISTS risks_business_id_businesses_id_fk;
ALTER TABLE IF EXISTS ONLY public.opportunities DROP CONSTRAINT IF EXISTS opportunities_workspace_id_workspaces_id_fk;
ALTER TABLE IF EXISTS ONLY public.opportunities DROP CONSTRAINT IF EXISTS opportunities_business_id_businesses_id_fk;
ALTER TABLE IF EXISTS ONLY public.memories DROP CONSTRAINT IF EXISTS memories_workspace_id_workspaces_id_fk;
ALTER TABLE IF EXISTS ONLY public.insights DROP CONSTRAINT IF EXISTS insights_workspace_id_workspaces_id_fk;
ALTER TABLE IF EXISTS ONLY public.events DROP CONSTRAINT IF EXISTS events_workspace_id_workspaces_id_fk;
ALTER TABLE IF EXISTS ONLY public.businesses DROP CONSTRAINT IF EXISTS businesses_workspace_id_workspaces_id_fk;
ALTER TABLE IF EXISTS ONLY public.browser_sessions DROP CONSTRAINT IF EXISTS browser_sessions_workspace_id_workspaces_id_fk;
ALTER TABLE IF EXISTS ONLY public.browser_actions DROP CONSTRAINT IF EXISTS browser_actions_session_id_browser_sessions_id_fk;
ALTER TABLE IF EXISTS ONLY public.briefing_items DROP CONSTRAINT IF EXISTS briefing_items_briefing_id_briefings_id_fk;
ALTER TABLE IF EXISTS ONLY public.approvals DROP CONSTRAINT IF EXISTS approvals_workspace_id_workspaces_id_fk;
ALTER TABLE IF EXISTS ONLY public.approvals DROP CONSTRAINT IF EXISTS approvals_run_id_workflow_runs_id_fk;
ALTER TABLE IF EXISTS ONLY public.agents DROP CONSTRAINT IF EXISTS agents_workspace_id_workspaces_id_fk;
DROP INDEX IF EXISTS public.wt_workspace_idx;
DROP INDEX IF EXISTS public.wt_trace_idx;
DROP INDEX IF EXISTS public.wt_run_idx;
DROP INDEX IF EXISTS public.wort_worker_idx;
DROP INDEX IF EXISTS public.wort_trace_idx;
DROP INDEX IF EXISTS public.wort_queue_idx;
DROP INDEX IF EXISTS public.workflow_run_workspace_idx;
DROP INDEX IF EXISTS public.workflow_run_triggered_idx;
DROP INDEX IF EXISTS public.workflow_run_status_idx;
DROP INDEX IF EXISTS public.workflow_def_workspace_idx;
DROP INDEX IF EXISTS public.workflow_def_tags_idx;
DROP INDEX IF EXISTS public.webhook_workspace_idx;
DROP INDEX IF EXISTS public.webhook_active_idx;
DROP INDEX IF EXISTS public.wdel_workspace_idx;
DROP INDEX IF EXISTS public.wdel_webhook_idx;
DROP INDEX IF EXISTS public.tt_workspace_idx;
DROP INDEX IF EXISTS public.tt_trace_idx;
DROP INDEX IF EXISTS public.tt_run_idx;
DROP INDEX IF EXISTS public.token_workspace_idx;
DROP INDEX IF EXISTS public.token_hash_idx;
DROP INDEX IF EXISTS public.step_run_status_idx;
DROP INDEX IF EXISTS public.step_run_run_idx;
DROP INDEX IF EXISTS public.snap_workspace_idx;
DROP INDEX IF EXISTS public.snap_trace_idx;
DROP INDEX IF EXISTS public.snap_run_idx;
DROP INDEX IF EXISTS public.si_snapshot_idx;
DROP INDEX IF EXISTS public.si_entity_idx;
DROP INDEX IF EXISTS public.scheduled_triggers_ws_idx;
DROP INDEX IF EXISTS public.scheduled_triggers_enabled_idx;
DROP INDEX IF EXISTS public.rr_workspace_idx;
DROP INDEX IF EXISTS public.rr_status_idx;
DROP INDEX IF EXISTS public.rr_run_idx;
DROP INDEX IF EXISTS public.risk_workspace_idx;
DROP INDEX IF EXISTS public.risk_severity_idx;
DROP INDEX IF EXISTS public.risk_score_idx;
DROP INDEX IF EXISTS public.recovery_workspace_idx;
DROP INDEX IF EXISTS public.recovery_run_idx;
DROP INDEX IF EXISTS public.rcp_workspace_idx;
DROP INDEX IF EXISTS public.rcp_run_idx;
DROP INDEX IF EXISTS public.rb_workspace_idx;
DROP INDEX IF EXISTS public.rb_request_idx;
DROP INDEX IF EXISTS public.qt_trace_idx;
DROP INDEX IF EXISTS public.qt_queue_idx;
DROP INDEX IF EXISTS public.qt_job_idx;
DROP INDEX IF EXISTS public.pt_workspace_idx;
DROP INDEX IF EXISTS public.pt_verdict_idx;
DROP INDEX IF EXISTS public.pt_trace_idx;
DROP INDEX IF EXISTS public.opportunity_workspace_idx;
DROP INDEX IF EXISTS public.opportunity_type_idx;
DROP INDEX IF EXISTS public.opportunity_status_idx;
DROP INDEX IF EXISTS public.opportunity_score_idx;
DROP INDEX IF EXISTS public.opportunity_priority_idx;
DROP INDEX IF EXISTS public.notif_workspace_idx;
DROP INDEX IF EXISTS public.notif_read_idx;
DROP INDEX IF EXISTS public.notif_created_idx;
DROP INDEX IF EXISTS public.memory_workspace_idx;
DROP INDEX IF EXISTS public.memory_type_idx;
DROP INDEX IF EXISTS public.memory_tags_idx;
DROP INDEX IF EXISTS public.memory_created_idx;
DROP INDEX IF EXISTS public.insight_workspace_idx;
DROP INDEX IF EXISTS public.insight_created_idx;
DROP INDEX IF EXISTS public.insight_category_idx;
DROP INDEX IF EXISTS public.goal_workspace_idx;
DROP INDEX IF EXISTS public.goal_status_idx;
DROP INDEX IF EXISTS public.goal_horizon_idx;
DROP INDEX IF EXISTS public.fl_workspace_idx;
DROP INDEX IF EXISTS public.fl_trace_idx;
DROP INDEX IF EXISTS public.fl_run_idx;
DROP INDEX IF EXISTS public.event_workspace_type_idx;
DROP INDEX IF EXISTS public.event_trace_idx;
DROP INDEX IF EXISTS public.event_created_idx;
DROP INDEX IF EXISTS public.et_workspace_idx;
DROP INDEX IF EXISTS public.et_trace_idx;
DROP INDEX IF EXISTS public.et_created_idx;
DROP INDEX IF EXISTS public.dlq_workspace_idx;
DROP INDEX IF EXISTS public.dlq_queue_idx;
DROP INDEX IF EXISTS public.dlq_dead_lettered_at_idx;
DROP INDEX IF EXISTS public.business_workspace_idx;
DROP INDEX IF EXISTS public.bsess_workspace_idx;
DROP INDEX IF EXISTS public.bsess_started_idx;
DROP INDEX IF EXISTS public.bsess_job_idx;
DROP INDEX IF EXISTS public.briefing_workspace_idx;
DROP INDEX IF EXISTS public.briefing_status_idx;
DROP INDEX IF EXISTS public.briefing_created_idx;
DROP INDEX IF EXISTS public.bi_workspace_idx;
DROP INDEX IF EXISTS public.bi_section_idx;
DROP INDEX IF EXISTS public.bi_converted_idx;
DROP INDEX IF EXISTS public.bi_briefing_idx;
DROP INDEX IF EXISTS public.bact_workspace_idx;
DROP INDEX IF EXISTS public.bact_session_idx;
DROP INDEX IF EXISTS public.at_workspace_idx;
DROP INDEX IF EXISTS public.at_trace_idx;
DROP INDEX IF EXISTS public.at_approval_idx;
DROP INDEX IF EXISTS public.approval_workspace_idx;
DROP INDEX IF EXISTS public.approval_status_idx;
DROP INDEX IF EXISTS public.approval_expires_idx;
DROP INDEX IF EXISTS public.ai_usage_workspace_idx;
DROP INDEX IF EXISTS public.ai_usage_timestamp_idx;
DROP INDEX IF EXISTS public.agent_workspace_idx;
DROP INDEX IF EXISTS public.agent_status_idx;
ALTER TABLE IF EXISTS ONLY public.workspaces DROP CONSTRAINT IF EXISTS workspaces_slug_unique;
ALTER TABLE IF EXISTS ONLY public.workspaces DROP CONSTRAINT IF EXISTS workspaces_pkey;
ALTER TABLE IF EXISTS ONLY public.workflow_traces DROP CONSTRAINT IF EXISTS workflow_traces_pkey;
ALTER TABLE IF EXISTS ONLY public.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_pkey;
ALTER TABLE IF EXISTS ONLY public.workflow_definitions DROP CONSTRAINT IF EXISTS workflow_definitions_pkey;
ALTER TABLE IF EXISTS ONLY public.worker_traces DROP CONSTRAINT IF EXISTS worker_traces_pkey;
ALTER TABLE IF EXISTS ONLY public.webhooks DROP CONSTRAINT IF EXISTS webhooks_pkey;
ALTER TABLE IF EXISTS ONLY public.webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_pkey;
ALTER TABLE IF EXISTS ONLY public.task_traces DROP CONSTRAINT IF EXISTS task_traces_pkey;
ALTER TABLE IF EXISTS ONLY public.strategic_goals DROP CONSTRAINT IF EXISTS strategic_goals_pkey;
ALTER TABLE IF EXISTS ONLY public.step_runs DROP CONSTRAINT IF EXISTS step_runs_pkey;
ALTER TABLE IF EXISTS ONLY public.snapshots DROP CONSTRAINT IF EXISTS snapshots_pkey;
ALTER TABLE IF EXISTS ONLY public.snapshot_items DROP CONSTRAINT IF EXISTS snapshot_items_pkey;
ALTER TABLE IF EXISTS ONLY public.scheduled_triggers DROP CONSTRAINT IF EXISTS scheduled_triggers_pkey;
ALTER TABLE IF EXISTS ONLY public.rollback_results DROP CONSTRAINT IF EXISTS rollback_results_pkey;
ALTER TABLE IF EXISTS ONLY public.rollback_requests DROP CONSTRAINT IF EXISTS rollback_requests_pkey;
ALTER TABLE IF EXISTS ONLY public.risks DROP CONSTRAINT IF EXISTS risks_pkey;
ALTER TABLE IF EXISTS ONLY public.recovery_log DROP CONSTRAINT IF EXISTS recovery_log_pkey;
ALTER TABLE IF EXISTS ONLY public.recovery_checkpoints DROP CONSTRAINT IF EXISTS recovery_checkpoints_pkey;
ALTER TABLE IF EXISTS ONLY public.queue_traces DROP CONSTRAINT IF EXISTS queue_traces_pkey;
ALTER TABLE IF EXISTS ONLY public.policy_traces DROP CONSTRAINT IF EXISTS policy_traces_pkey;
ALTER TABLE IF EXISTS ONLY public.opportunities DROP CONSTRAINT IF EXISTS opportunities_pkey;
ALTER TABLE IF EXISTS ONLY public.notifications DROP CONSTRAINT IF EXISTS notifications_pkey;
ALTER TABLE IF EXISTS ONLY public.memories DROP CONSTRAINT IF EXISTS memories_pkey;
ALTER TABLE IF EXISTS ONLY public.insights DROP CONSTRAINT IF EXISTS insights_pkey;
ALTER TABLE IF EXISTS ONLY public.failure_lineages DROP CONSTRAINT IF EXISTS failure_lineages_pkey;
ALTER TABLE IF EXISTS ONLY public.events DROP CONSTRAINT IF EXISTS events_pkey;
ALTER TABLE IF EXISTS ONLY public.event_traces DROP CONSTRAINT IF EXISTS event_traces_pkey;
ALTER TABLE IF EXISTS ONLY public.dead_letter_jobs DROP CONSTRAINT IF EXISTS dead_letter_jobs_pkey;
ALTER TABLE IF EXISTS ONLY public.businesses DROP CONSTRAINT IF EXISTS businesses_pkey;
ALTER TABLE IF EXISTS ONLY public.browser_sessions DROP CONSTRAINT IF EXISTS browser_sessions_pkey;
ALTER TABLE IF EXISTS ONLY public.browser_actions DROP CONSTRAINT IF EXISTS browser_actions_pkey;
ALTER TABLE IF EXISTS ONLY public.briefings DROP CONSTRAINT IF EXISTS briefings_pkey;
ALTER TABLE IF EXISTS ONLY public.briefing_items DROP CONSTRAINT IF EXISTS briefing_items_pkey;
ALTER TABLE IF EXISTS ONLY public.approvals DROP CONSTRAINT IF EXISTS approvals_pkey;
ALTER TABLE IF EXISTS ONLY public.approval_traces DROP CONSTRAINT IF EXISTS approval_traces_pkey;
ALTER TABLE IF EXISTS ONLY public.api_tokens DROP CONSTRAINT IF EXISTS api_tokens_token_hash_unique;
ALTER TABLE IF EXISTS ONLY public.api_tokens DROP CONSTRAINT IF EXISTS api_tokens_pkey;
ALTER TABLE IF EXISTS ONLY public.ai_usage DROP CONSTRAINT IF EXISTS ai_usage_pkey;
ALTER TABLE IF EXISTS ONLY public.agents DROP CONSTRAINT IF EXISTS agents_pkey;
DROP TABLE IF EXISTS public.workspaces;
DROP TABLE IF EXISTS public.workflow_traces;
DROP TABLE IF EXISTS public.workflow_runs;
DROP TABLE IF EXISTS public.workflow_definitions;
DROP TABLE IF EXISTS public.worker_traces;
DROP TABLE IF EXISTS public.webhooks;
DROP TABLE IF EXISTS public.webhook_deliveries;
DROP TABLE IF EXISTS public.task_traces;
DROP TABLE IF EXISTS public.strategic_goals;
DROP TABLE IF EXISTS public.step_runs;
DROP TABLE IF EXISTS public.snapshots;
DROP TABLE IF EXISTS public.snapshot_items;
DROP TABLE IF EXISTS public.scheduled_triggers;
DROP TABLE IF EXISTS public.rollback_results;
DROP TABLE IF EXISTS public.rollback_requests;
DROP TABLE IF EXISTS public.risks;
DROP TABLE IF EXISTS public.recovery_log;
DROP TABLE IF EXISTS public.recovery_checkpoints;
DROP TABLE IF EXISTS public.queue_traces;
DROP TABLE IF EXISTS public.policy_traces;
DROP TABLE IF EXISTS public.opportunities;
DROP TABLE IF EXISTS public.notifications;
DROP TABLE IF EXISTS public.memories;
DROP TABLE IF EXISTS public.insights;
DROP TABLE IF EXISTS public.failure_lineages;
DROP TABLE IF EXISTS public.events;
DROP TABLE IF EXISTS public.event_traces;
DROP TABLE IF EXISTS public.dead_letter_jobs;
DROP TABLE IF EXISTS public.businesses;
DROP TABLE IF EXISTS public.browser_sessions;
DROP TABLE IF EXISTS public.browser_actions;
DROP TABLE IF EXISTS public.briefings;
DROP TABLE IF EXISTS public.briefing_items;
DROP TABLE IF EXISTS public.approvals;
DROP TABLE IF EXISTS public.approval_traces;
DROP TABLE IF EXISTS public.api_tokens;
DROP TABLE IF EXISTS public.ai_usage;
DROP TABLE IF EXISTS public.agents;
DROP TYPE IF EXISTS public.workflow_status;
DROP TYPE IF EXISTS public.step_status;
DROP TYPE IF EXISTS public.risk_severity;
DROP TYPE IF EXISTS public.opportunity_status;
DROP TYPE IF EXISTS public.memory_type;
DROP TYPE IF EXISTS public.job_priority;
DROP TYPE IF EXISTS public.goal_status;
DROP TYPE IF EXISTS public.approval_status;
DROP TYPE IF EXISTS public.agent_status;
DROP EXTENSION IF EXISTS vector;
--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: agent_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.agent_status AS ENUM (
    'idle',
    'running',
    'paused',
    'error',
    'offline'
);


--
-- Name: approval_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.approval_status AS ENUM (
    'pending',
    'approved',
    'rejected',
    'expired'
);


--
-- Name: goal_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.goal_status AS ENUM (
    'draft',
    'active',
    'paused',
    'completed',
    'abandoned'
);


--
-- Name: job_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.job_priority AS ENUM (
    '1',
    '2',
    '3',
    '4',
    '5'
);


--
-- Name: memory_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.memory_type AS ENUM (
    'observation',
    'decision',
    'lesson',
    'goal',
    'idea',
    'fact',
    'strategic',
    'operational'
);


--
-- Name: opportunity_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.opportunity_status AS ENUM (
    'identified',
    'evaluating',
    'active',
    'won',
    'lost',
    'deferred',
    'accepted',
    'rejected',
    'stale',
    'completed'
);


--
-- Name: risk_severity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.risk_severity AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);


--
-- Name: step_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.step_status AS ENUM (
    'pending',
    'running',
    'completed',
    'failed',
    'skipped',
    'retrying'
);


--
-- Name: workflow_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.workflow_status AS ENUM (
    'pending',
    'running',
    'paused',
    'completed',
    'failed',
    'cancelled',
    'awaiting_approval'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    description text,
    type text NOT NULL,
    status public.agent_status DEFAULT 'idle'::public.agent_status NOT NULL,
    capabilities text[] DEFAULT '{}'::text[] NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_active_at bigint,
    heartbeat_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: ai_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    workspace_id text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    prompt_tokens integer NOT NULL,
    output_tokens integer NOT NULL,
    cost_usd real NOT NULL,
    latency_ms integer NOT NULL,
    cached boolean DEFAULT false NOT NULL,
    task_type text NOT NULL,
    "timestamp" bigint NOT NULL
);


--
-- Name: api_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_tokens (
    id text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    prefix text NOT NULL,
    scopes text[] DEFAULT '{read,write}'::text[] NOT NULL,
    last_used_at bigint,
    expires_at bigint,
    revoked_at bigint,
    created_at bigint NOT NULL
);


--
-- Name: approval_traces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_traces (
    id text NOT NULL,
    workspace_id text NOT NULL,
    trace_id text NOT NULL,
    approval_id text NOT NULL,
    run_id text NOT NULL,
    step_id text NOT NULL,
    status text NOT NULL,
    requested_by text NOT NULL,
    resolved_by text,
    requested_at bigint NOT NULL,
    resolved_at bigint,
    expires_at bigint NOT NULL,
    operation_label text NOT NULL,
    risk text NOT NULL,
    created_at bigint NOT NULL
);


--
-- Name: approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approvals (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    step_id text NOT NULL,
    requested_by text NOT NULL,
    requested_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    status public.approval_status DEFAULT 'pending'::public.approval_status NOT NULL,
    resolved_by text,
    resolved_at bigint,
    operation_label text NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    risk text NOT NULL
);


--
-- Name: briefing_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.briefing_items (
    id text NOT NULL,
    briefing_id text NOT NULL,
    workspace_id text NOT NULL,
    section text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    confidence real DEFAULT 0.8 NOT NULL,
    is_low_confidence boolean DEFAULT false NOT NULL,
    source text NOT NULL,
    source_ref text,
    source_label text,
    converted boolean DEFAULT false NOT NULL,
    converted_at bigint,
    converted_run_id text,
    converted_workflow_id text,
    priority integer DEFAULT 50 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at bigint NOT NULL
);


--
-- Name: briefings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.briefings (
    id text NOT NULL,
    workspace_id text NOT NULL,
    status text DEFAULT 'generating'::text NOT NULL,
    requested_by text DEFAULT 'system'::text NOT NULL,
    trace_id text NOT NULL,
    window_ms bigint DEFAULT 86400000 NOT NULL,
    summary text,
    error_message text,
    generated_at bigint,
    created_at bigint NOT NULL
);


--
-- Name: browser_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_actions (
    id text NOT NULL,
    session_id text NOT NULL,
    workspace_id text NOT NULL,
    action_type text NOT NULL,
    action_input jsonb DEFAULT '{}'::jsonb NOT NULL,
    success boolean DEFAULT false NOT NULL,
    output jsonb,
    error text,
    screenshot_path text,
    duration_ms integer,
    executed_at bigint NOT NULL
);


--
-- Name: browser_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_sessions (
    id text NOT NULL,
    workspace_id text NOT NULL,
    job_id text NOT NULL,
    run_id text,
    step_id text,
    trace_id text NOT NULL,
    url text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    page_title text,
    page_text text,
    screenshot_path text,
    error_message text,
    duration_ms integer,
    started_at bigint NOT NULL,
    completed_at bigint,
    created_at bigint NOT NULL
);


--
-- Name: businesses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.businesses (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    domain text,
    industry text,
    stage text DEFAULT 'early'::text NOT NULL,
    health text DEFAULT 'green'::text NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: dead_letter_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dead_letter_jobs (
    id text NOT NULL,
    queue_name text NOT NULL,
    job_id text NOT NULL,
    job_name text NOT NULL,
    workspace_id text NOT NULL,
    payload jsonb NOT NULL,
    error text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    worker_id text NOT NULL,
    trace_id text,
    first_failed_at bigint NOT NULL,
    dead_lettered_at bigint NOT NULL,
    replayed_at bigint,
    replayed_by text,
    replay_run_id text
);


--
-- Name: event_traces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_traces (
    id text NOT NULL,
    workspace_id text NOT NULL,
    trace_id text NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    source text NOT NULL,
    payload jsonb NOT NULL,
    created_at bigint NOT NULL
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    type text NOT NULL,
    workspace_id text NOT NULL,
    payload jsonb NOT NULL,
    trace_id text NOT NULL,
    correlation_id text NOT NULL,
    causation_id text,
    source text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at bigint NOT NULL
);


--
-- Name: failure_lineages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.failure_lineages (
    id text NOT NULL,
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    trace_id text NOT NULL,
    root_cause text,
    failure_chain jsonb NOT NULL,
    affected_steps text[] DEFAULT '{}'::text[] NOT NULL,
    recovery_attempts integer DEFAULT 0 NOT NULL,
    resolved boolean DEFAULT false NOT NULL,
    resolved_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insights (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    workspace_id text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    category text DEFAULT 'operational'::text NOT NULL,
    confidence real DEFAULT 0.8 NOT NULL,
    source text NOT NULL,
    source_ref text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    embedding public.vector(1536),
    dismissed boolean DEFAULT false NOT NULL,
    acted_on boolean DEFAULT false NOT NULL,
    expires_at bigint,
    created_at bigint NOT NULL
);


--
-- Name: memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memories (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    workspace_id text NOT NULL,
    type public.memory_type NOT NULL,
    content text NOT NULL,
    summary text,
    embedding public.vector(1536),
    confidence real DEFAULT 1 NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    source text NOT NULL,
    source_ref text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    expires_at bigint
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id text NOT NULL,
    workspace_id text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    type text DEFAULT 'info'::text NOT NULL,
    category text DEFAULT 'system'::text NOT NULL,
    read boolean DEFAULT false NOT NULL,
    dismissed boolean DEFAULT false NOT NULL,
    source_type text,
    source_id text,
    action_url text,
    expires_at bigint,
    created_at bigint NOT NULL
);


--
-- Name: opportunities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.opportunities (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    workspace_id text NOT NULL,
    business_id text,
    title text NOT NULL,
    description text,
    type text DEFAULT 'operational'::text NOT NULL,
    status public.opportunity_status DEFAULT 'identified'::public.opportunity_status NOT NULL,
    priority integer DEFAULT 50 NOT NULL,
    value_potential real,
    confidence real DEFAULT 0.5 NOT NULL,
    category text DEFAULT 'growth'::text NOT NULL,
    evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    estimated_roi real,
    estimated_effort text,
    risk_level text,
    strategic_alignment real,
    score real,
    score_breakdown jsonb,
    linked_memory_ids text[] DEFAULT '{}'::text[] NOT NULL,
    linked_workflow_ids text[] DEFAULT '{}'::text[] NOT NULL,
    converted_run_id text,
    converted_workflow_id text,
    converted_at bigint,
    accepted_at bigint,
    rejected_at bigint,
    due_date bigint,
    closed_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: policy_traces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_traces (
    id text NOT NULL,
    workspace_id text NOT NULL,
    trace_id text NOT NULL,
    policy_id text NOT NULL,
    policy_name text NOT NULL,
    action text NOT NULL,
    verdict text NOT NULL,
    risk_level text NOT NULL,
    agent_id text,
    checked_at bigint NOT NULL,
    created_at bigint NOT NULL
);


--
-- Name: queue_traces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.queue_traces (
    id text NOT NULL,
    workspace_id text,
    trace_id text NOT NULL,
    queue_name text NOT NULL,
    job_id text NOT NULL,
    job_name text NOT NULL,
    event text NOT NULL,
    duration_ms integer,
    attempt integer,
    error text,
    created_at bigint NOT NULL
);


--
-- Name: recovery_checkpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_checkpoints (
    id text NOT NULL,
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    step_id text NOT NULL,
    trace_id text NOT NULL,
    completed_steps text[] DEFAULT '{}'::text[] NOT NULL,
    state jsonb NOT NULL,
    snapshot_id text,
    restored_at bigint,
    restored_by text,
    created_at bigint NOT NULL
);


--
-- Name: recovery_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_log (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    strategy text NOT NULL,
    reason text NOT NULL,
    steps jsonb NOT NULL,
    status text NOT NULL,
    started_at bigint NOT NULL,
    completed_at bigint,
    error text
);


--
-- Name: risks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.risks (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    workspace_id text NOT NULL,
    business_id text,
    title text NOT NULL,
    description text,
    severity public.risk_severity DEFAULT 'medium'::public.risk_severity NOT NULL,
    probability real DEFAULT 0.5 NOT NULL,
    impact real DEFAULT 0.5 NOT NULL,
    risk_score real DEFAULT 0.25 NOT NULL,
    category text DEFAULT 'operational'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    mitigations jsonb DEFAULT '[]'::jsonb NOT NULL,
    detected_at bigint NOT NULL,
    resolved_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: rollback_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rollback_requests (
    id text NOT NULL,
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    snapshot_id text,
    trace_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    reason text NOT NULL,
    requested_by text NOT NULL,
    started_at bigint,
    completed_at bigint,
    created_at bigint NOT NULL
);


--
-- Name: rollback_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rollback_results (
    id text NOT NULL,
    request_id text NOT NULL,
    workspace_id text NOT NULL,
    item_id text NOT NULL,
    status text NOT NULL,
    error text,
    restored_at bigint,
    created_at bigint NOT NULL
);


--
-- Name: scheduled_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_triggers (
    id text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    description text,
    workflow_id text NOT NULL,
    cron_expression text NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_run_at bigint,
    next_run_at bigint,
    last_run_status text,
    run_count integer DEFAULT 0 NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    payload jsonb,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: snapshot_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snapshot_items (
    id text NOT NULL,
    snapshot_id text NOT NULL,
    workspace_id text NOT NULL,
    item_type text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    before_state jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at bigint NOT NULL
);


--
-- Name: snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snapshots (
    id text NOT NULL,
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    step_id text,
    trace_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    description text,
    item_count integer DEFAULT 0 NOT NULL,
    size_bytes integer DEFAULT 0 NOT NULL,
    expires_at bigint,
    created_at bigint NOT NULL
);


--
-- Name: step_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.step_runs (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    run_id text NOT NULL,
    step_id text NOT NULL,
    workspace_id text NOT NULL,
    status public.step_status DEFAULT 'pending'::public.step_status NOT NULL,
    started_at bigint,
    completed_at bigint,
    output jsonb,
    error text,
    attempt integer DEFAULT 1 NOT NULL,
    rollback jsonb
);


--
-- Name: strategic_goals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strategic_goals (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    workspace_id text NOT NULL,
    business_id text,
    parent_goal_id text,
    title text NOT NULL,
    description text,
    status public.goal_status DEFAULT 'draft'::public.goal_status NOT NULL,
    horizon text DEFAULT 'quarter'::text NOT NULL,
    target_date bigint,
    progress real DEFAULT 0 NOT NULL,
    key_results jsonb DEFAULT '[]'::jsonb NOT NULL,
    owners text[] DEFAULT '{}'::text[] NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    completed_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: task_traces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_traces (
    id text NOT NULL,
    workspace_id text NOT NULL,
    trace_id text NOT NULL,
    run_id text NOT NULL,
    step_id text NOT NULL,
    step_type text NOT NULL,
    status text NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    started_at bigint,
    completed_at bigint,
    duration_ms integer,
    output jsonb,
    error text,
    created_at bigint NOT NULL
);


--
-- Name: webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_deliveries (
    id text NOT NULL,
    webhook_id text NOT NULL,
    workspace_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    run_id text,
    error text,
    created_at bigint NOT NULL
);


--
-- Name: webhooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhooks (
    id text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    secret text NOT NULL,
    events text[] DEFAULT '{}'::text[] NOT NULL,
    target_url text,
    workflow_id text,
    active boolean DEFAULT true NOT NULL,
    call_count integer DEFAULT 0 NOT NULL,
    last_called_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: worker_traces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_traces (
    id text NOT NULL,
    workspace_id text,
    trace_id text NOT NULL,
    worker_id text NOT NULL,
    worker_name text NOT NULL,
    queue_name text NOT NULL,
    event text NOT NULL,
    heap_used_mb real,
    rss_mem_mb real,
    active_jobs integer,
    processed_jobs integer,
    created_at bigint NOT NULL
);


--
-- Name: workflow_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_definitions (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    description text,
    version integer DEFAULT 1 NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    triggers jsonb DEFAULT '[]'::jsonb NOT NULL,
    retry_policy jsonb NOT NULL,
    timeout integer DEFAULT 300000 NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Name: workflow_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_runs (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    workflow_id text NOT NULL,
    workspace_id text NOT NULL,
    status public.workflow_status DEFAULT 'pending'::public.workflow_status NOT NULL,
    triggered_by text NOT NULL,
    triggered_at bigint NOT NULL,
    started_at bigint,
    completed_at bigint,
    failed_at bigint,
    error_message text,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    parent_run_id text,
    checkpoint_at bigint,
    checkpoint_state jsonb,
    trace_id text NOT NULL
);


--
-- Name: workflow_traces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_traces (
    id text NOT NULL,
    workspace_id text NOT NULL,
    trace_id text NOT NULL,
    run_id text NOT NULL,
    workflow_id text NOT NULL,
    status text NOT NULL,
    triggered_by text NOT NULL,
    started_at bigint,
    completed_at bigint,
    failed_at bigint,
    duration_ms integer,
    step_count integer DEFAULT 0 NOT NULL,
    error_message text,
    created_at bigint NOT NULL
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id text DEFAULT 'gen_random_uuid()'::text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    plan text DEFAULT 'free'::text NOT NULL,
    owner_id text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);


--
-- Data for Name: agents; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.agents (id, workspace_id, name, description, type, status, capabilities, config, last_active_at, heartbeat_at, created_at, updated_at) FROM stdin;
019e2a13-9ddf-73e1-ac5c-739f2bfaca51	default	Strategist	High-level planning agent that synthesizes signals into strategic recommendations	llm	idle	{briefing,opportunity-scoring,goal-alignment,risk-assessment}	{"model": "claude-3-5-sonnet-20241022", "maxTokens": 8192, "temperature": 0.4}	1778822269214	1778822359214	1777094389214	1778822359214
019e2a13-9ddf-73e1-ac5c-7613cb63fd74	default	Operator	Execution agent responsible for running workflows, monitoring queues, and handling retries	workflow	running	{workflow-execution,retry-handling,approval-routing,notification-dispatch}	{"queues": ["default", "priority", "briefing"], "timeoutMs": 300000, "concurrency": 5}	1778822384214	1778822384214	1777094389214	1778822384214
\.


--
-- Data for Name: ai_usage; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ai_usage (id, workspace_id, provider, model, prompt_tokens, output_tokens, cost_usd, latency_ms, cached, task_type, "timestamp") FROM stdin;
019e2a13-9e43-76ec-bef3-c383329e356d	default	anthropic	claude-3-5-sonnet-20241022	8400	1820	0.038	2340	f	briefing-generation	1778805109214
019e2a13-9e43-76ec-bef3-c73d5823d1ca	default	anthropic	claude-3-5-haiku-20241022	3200	640	0.006	820	t	opportunity-scoring	1778779189214
019e2a13-9e43-76ec-bef3-cbc45d560c0c	default	anthropic	claude-3-5-sonnet-20241022	12100	2400	0.047	3180	f	risk-evaluation	1778735989214
019e2a13-9e43-76ec-bef3-ce0ac2fe37e3	default	openai	text-embedding-3-small	4800	0	0.001	310	f	memory-embedding	1778692789214
019e2a13-9e43-76ec-bef3-d07d97fde47d	default	anthropic	claude-3-5-sonnet-20241022	9600	1960	0.041	2670	t	insight-generation	1778649589214
019e2a13-9e43-76ec-bef3-d5157b2c34e9	default	anthropic	claude-3-5-haiku-20241022	2800	520	0.005	740	f	opportunity-scoring	1778563189214
019e2a13-9e43-76ec-bef3-da594d188637	default	openai	text-embedding-3-small	6200	0	0.001	290	f	memory-embedding	1778476789214
019e2a13-9e43-76ec-bef3-dcacfae332f9	default	anthropic	claude-3-5-sonnet-20241022	7800	1640	0.034	2190	f	briefing-generation	1778390389214
019e2a13-9e43-76ec-bef3-e1ee5402e7d0	default	anthropic	claude-3-opus-20240229	5200	1100	0.094	4820	f	strategic-planning	1778217589214
019e2a13-9e43-76ec-bef3-e7a048a1bebc	default	anthropic	claude-3-5-haiku-20241022	1900	380	0.003	610	t	event-classification	1778044789214
019e2a19-8823-725b-981c-2768f70119f4	default	anthropic	claude-3-5-sonnet	150	80	0.0012	850	f	chat	1778822776867
\.


--
-- Data for Name: api_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.api_tokens (id, workspace_id, name, token_hash, prefix, scopes, last_used_at, expires_at, revoked_at, created_at) FROM stdin;
beba791c-e64a-4d34-bb50-f6c38172b36b	default	rc1-test-token	27e5126117f43af43607d01c656be6f2f15a80f04e4851123a3f6a9c6f3f6729	ops_e8cd8226	{read,write}	\N	\N	\N	1778822594104
\.


--
-- Data for Name: approval_traces; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.approval_traces (id, workspace_id, trace_id, approval_id, run_id, step_id, status, requested_by, resolved_by, requested_at, resolved_at, expires_at, operation_label, risk, created_at) FROM stdin;
\.


--
-- Data for Name: approvals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.approvals (id, workspace_id, run_id, step_id, requested_by, requested_at, expires_at, status, resolved_by, resolved_at, operation_label, context, risk) FROM stdin;
\.


--
-- Data for Name: briefing_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.briefing_items (id, briefing_id, workspace_id, section, title, body, confidence, is_low_confidence, source, source_ref, source_label, converted, converted_at, converted_run_id, converted_workflow_id, priority, metadata, created_at) FROM stdin;
019e2a13-9e3c-7417-aa85-0267160b8c38	019e2a13-9ddf-73e1-ac5c-7beb421c1224	default	top_priorities	Activate key account retention plan	Three enterprise accounts (combined ARR 210K) are at renewal risk. Escalate to CS lead immediately and schedule executive business reviews.	0.91	f	risks	\N	\N	f	\N	\N	\N	100	{"riskSeverity": "critical"}	1778390389214
019e2a13-9e3c-7417-aa85-043299d94fe5	019e2a13-9ddf-73e1-ac5c-7beb421c1224	default	opportunities	Gamma Analytics partnership ready to advance	Initial call complete. Next step: send term sheet for co-sell agreement. Potential 120K revenue in year one.	0.78	f	opportunities	\N	\N	f	\N	\N	\N	90	{"opportunityType": "business"}	1778390389214
019e2a13-9e3c-7417-aa85-0956f6c3e61a	019e2a13-9ddf-73e1-ac5c-7f24d7d80b8c	default	risks	AI provider rate limits approaching capacity	Usage at 82% of tier-2 limits. Engineering should implement queue smoothing before next batch run.	0.87	f	events	\N	\N	f	\N	\N	\N	80	{"category": "technical"}	1778735989214
019e2a13-9e3c-7417-aa85-0fd4b52d9542	019e2a13-9ddf-73e1-ac5c-7f24d7d80b8c	default	next_actions	Schedule mid-market outbound campaign for Tuesday	Email analysis shows Tuesday 8-10am outperforms all other slots by 31%. Align campaign timing accordingly.	0.82	f	insights	\N	\N	f	\N	\N	\N	70	{"insightCategory": "marketing"}	1778735989214
019e2a28-a1f3-74ce-885c-fedc214c5d47	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	top_priorities	High risk: Key account renewal at risk	Severity critical, risk score 65%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	95	{"severity": "critical", "riskScore": 0.65}	1778823766526
019e2a28-a1f3-74ce-885d-02f4ad826998	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	top_priorities	High risk: AI provider rate limit exposure	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823766526
019e2a28-a1f3-74ce-885d-0707e2bd12a8	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	top_priorities	High risk: Competitor feature parity threat	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823766526
019e2a28-a1c7-774f-804d-a311225b8c88	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	risks	Key account renewal at risk	Three enterprise accounts (combined ARR 210K) have not logged in for 45+ days and renewal dates are within 60 days. Probability 68%, impact 95%. Category: revenue.	0.95	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	65	{"impact": 0.95, "severity": "critical", "probability": 0.68}	1778823766526
019e2a28-a1c7-774f-804d-a7809042ccf3	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	risks	AI provider rate limit exposure	Current usage is at 82% of Anthropic tier-2 rate limits. A spike during batch briefing jobs could cause cascading failures. Probability 55%, impact 70%. Category: technical.	0.925	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	39	{"impact": 0.7, "severity": "high", "probability": 0.55}	1778823766526
019e2a28-a1c7-774f-804d-aaabeff2b3a0	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	risks	Competitor feature parity threat	A well-funded competitor released workflow automation in beta. Early reviews indicate feature parity with our core offering within 3–6 months. Probability 60%, impact 65%. Category: competitive.	0.925	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	39	{"impact": 0.65, "severity": "high", "probability": 0.6}	1778823766526
019e2a28-a1cd-7636-a0ef-bff9f17036e7	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	opportunities	Gamma Analytics distribution partnership	Co-sell agreement with Gamma Analytics to offer Acme as a native integration to their 12K enterprise users. Estimated 300–500 qualified leads in year one. Confidence 72%. Est. value: $120,000. Category: partnerships.	0.72	f	opportunities	019e2a13-9e26-766b-afc4-abefa971fb50	Opportunity: Gamma Analytics distribution partnership	f	\N	\N	\N	95	{"status": "evaluating", "category": "partnerships", "valuePotential": 120000}	1778823766526
019e2a28-a1ee-741c-b704-17b4b4d35d3d	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	opportunities	Mid-market expansion via inside sales	Companies with 50–200 employees are underserved by current self-serve motion. A 3-person inside sales team could add 40–60K MRR within 6 months. Confidence 84%. Est. value: $60,000. Category: growth.	0.84	f	opportunities	019e2a13-9e26-766b-afc4-a2dfa48dc4ad	Opportunity: Mid-market expansion via inside sales	f	\N	\N	\N	90	{"status": "evaluating", "category": "growth", "valuePotential": 60000}	1778823766526
019e2a28-a1ee-741c-b704-1ac100f8997e	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	opportunities	AI-powered onboarding automation	Replace the 5-step manual onboarding checklist with an AI guide that adapts to user role and industry, projected to cut time-to-value from 14 days to 4. Confidence 78%. Est. value: $28,000. Category: retention.	0.78	f	opportunities	019e2a13-9e26-766b-afc4-a53ca2fa625b	Opportunity: AI-powered onboarding automation	f	\N	\N	\N	80	{"status": "identified", "category": "retention", "valuePotential": 28000}	1778823766526
019e2a28-a1ee-741c-b704-1dbc7cd65965	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	opportunities	Annual plan upsell campaign	Target the 340 monthly subscribers with >6 months tenure for an annual plan migration. Projected to lock in 1.4M ARR and reduce churn exposure. Confidence 88%. Est. value: $42,000. Category: monetization.	0.88	f	opportunities	019e2a13-9e26-766b-afc4-ae7aa314c1b4	Opportunity: Annual plan upsell campaign	f	\N	\N	\N	75	{"status": "identified", "category": "monetization", "valuePotential": 42000}	1778823766526
019e2a28-a1ee-741c-b704-214e8ff110bf	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	opportunities	Beta Ventures fintech integration	Beta Ventures needs a real-time transaction categorisation API. Building this as a paid add-on could serve the broader fintech vertical. Confidence 65%. Est. value: $15,000. Category: product.	0.65	t	opportunities	019e2a13-9e26-766b-afc4-b2b8f46c691f	Opportunity: Beta Ventures fintech integration	f	\N	\N	\N	55	{"status": "identified", "category": "product", "valuePotential": 15000}	1778823766526
019e2a28-a1f3-74ce-885d-08fe669fed9d	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	next_actions	Gamma partnership = 12K user distribution opportunity	Partnership with Gamma Analytics could unlock distribution to 12K enterprise users at near-zero CAC.	0.75	f	memories	019e2a13-9e1a-7209-9267-5b79142c257d	Memory (briefing)	f	\N	\N	\N	65	{"tags": ["partnerships", "distribution", "gamma"], "memorySource": "briefing"}	1778823766526
019e2a28-a1f3-74ce-885d-0df9d956df5b	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	next_actions	AI roadmap accelerated; mobile deferred to Q3	Decided to accelerate the AI feature roadmap and deprioritize the mobile app rewrite until Q3.	1	f	memories	019e2a13-9e1a-7209-9267-4dbc29b95aab	Memory (meeting)	f	\N	\N	\N	80	{"tags": ["strategy", "roadmap", "ai"], "memorySource": "meeting"}	1778823766526
019e2a28-a1f4-7447-9548-0cad02965043	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	next_actions	250K MRR by Q2 2026	Reach 250K MRR by end of Q2 2026 by expanding into mid-market accounts.	0.9	f	memories	019e2a13-9e1a-7209-9267-57cc1d3e6896	Memory (planning)	f	\N	\N	\N	74	{"tags": ["goal", "mrr", "mid-market"], "memorySource": "planning"}	1778823766526
019e2a28-a1f4-7447-9548-10e61c5a7aa5	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	next_actions	Milestone-triggered outbound 2.3x more effective	Outbound campaigns perform 2.3x better when triggered within 24h of a product usage milestone.	0.88	f	memories	019e2a13-9e1a-7209-9267-535e1112e616	Memory (experiment)	f	\N	\N	\N	73	{"tags": ["sales", "outbound", "timing"], "memorySource": "experiment"}	1778823766526
019e2a28-a1f7-742c-8828-397e8c1550da	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	next_actions	Revenue concentration risk: top 5 accounts = 38% of MRR	Five enterprise accounts contribute 38% of total MRR. If any two churn simultaneously, monthly revenue drops by more than 15%. Recommend accelerating mid-market diversification to reduce concentration below 25% by Q3.	0.93	f	insights	019e2a13-9e34-75dd-bcc5-ce35d8e684b2	Insight (revenue)	f	\N	\N	\N	77	{"category": "revenue", "insightSource": "ai-analyst"}	1778823766526
019e2a28-a1f7-742c-8828-3e34b20ae5c6	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	next_actions	AI workflow usage correlates with 2.1x higher NPS	Accounts actively using AI-generated briefings (≥3 per week) report an average NPS of 81 vs 39 for non-users. This suggests AI features are a primary satisfaction driver and should anchor the renewal and upsell narrative.	0.85	f	insights	019e2a13-9e34-75dd-bcc5-db8f620133f1	Insight (product)	f	\N	\N	\N	73	{"category": "product", "insightSource": "ai-analyst"}	1778823766526
019e2a28-a1f7-742c-8828-428831be8cb2	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	next_actions	Tuesday morning sends outperform Friday sends by 31% in email open rate	Review of 180-day email campaign data shows Tuesday 8–10am sends achieve 31.4% open rates vs 24.1% on Fridays. Scheduling the next pricing campaign for Tuesday 8am is expected to reach 3,200 additional recipients in the active window.	0.81	f	insights	019e2a13-9e34-75dd-bcc5-d79a202d0b21	Insight (marketing)	f	\N	\N	\N	71	{"category": "marketing", "insightSource": "ai-analyst"}	1778823766526
019e2a28-a1f7-742c-8828-462f7c82a658	019e2a28-a1a0-701c-a8d9-7927204cdb97	default	next_actions	Opportunity pipeline value increased 48% in the last 30 days	The combined estimated value of opportunities in "identified" and "evaluating" status grew from $148K to $219K over the past 30 days. Top contributors: Gamma Analytics partnership ($120K) and mid-market expansion ($60K). If both convert, H2 revenue targets are materially de-risked.	0.79	f	insights	019e2a13-9e34-75dd-bcc5-deaae426f4e4	Insight (strategic)	f	\N	\N	\N	70	{"category": "strategic", "insightSource": "ai-analyst"}	1778823766526
019e2a28-a337-7699-a3ba-13cb8deca29a	019e2a28-a329-7195-8405-1c02642c8bfd	default	top_priorities	High risk: Key account renewal at risk	Severity critical, risk score 65%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	95	{"severity": "critical", "riskScore": 0.65}	1778823766841
019e2a28-a337-7699-a3ba-16566f6798f2	019e2a28-a329-7195-8405-1c02642c8bfd	default	top_priorities	High risk: AI provider rate limit exposure	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823766841
019e2a28-a337-7699-a3ba-1a48598fbef2	019e2a28-a329-7195-8405-1c02642c8bfd	default	top_priorities	High risk: Competitor feature parity threat	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823766841
019e2a28-a333-71b9-9f5b-c1e1a64fa210	019e2a28-a329-7195-8405-1c02642c8bfd	default	risks	Key account renewal at risk	Three enterprise accounts (combined ARR 210K) have not logged in for 45+ days and renewal dates are within 60 days. Probability 68%, impact 95%. Category: revenue.	0.95	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	65	{"impact": 0.95, "severity": "critical", "probability": 0.68}	1778823766841
019e2a28-a333-71b9-9f5b-c4df6b42507c	019e2a28-a329-7195-8405-1c02642c8bfd	default	risks	AI provider rate limit exposure	Current usage is at 82% of Anthropic tier-2 rate limits. A spike during batch briefing jobs could cause cascading failures. Probability 55%, impact 70%. Category: technical.	0.925	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	39	{"impact": 0.7, "severity": "high", "probability": 0.55}	1778823766841
019e2a28-a333-71b9-9f5b-c9d477730b08	019e2a28-a329-7195-8405-1c02642c8bfd	default	risks	Competitor feature parity threat	A well-funded competitor released workflow automation in beta. Early reviews indicate feature parity with our core offering within 3–6 months. Probability 60%, impact 65%. Category: competitive.	0.925	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	39	{"impact": 0.65, "severity": "high", "probability": 0.6}	1778823766841
019e2a28-a336-756d-999c-32188a8f2a47	019e2a28-a329-7195-8405-1c02642c8bfd	default	opportunities	Gamma Analytics distribution partnership	Co-sell agreement with Gamma Analytics to offer Acme as a native integration to their 12K enterprise users. Estimated 300–500 qualified leads in year one. Confidence 72%. Est. value: $120,000. Category: partnerships.	0.72	f	opportunities	019e2a13-9e26-766b-afc4-abefa971fb50	Opportunity: Gamma Analytics distribution partnership	f	\N	\N	\N	95	{"status": "evaluating", "category": "partnerships", "valuePotential": 120000}	1778823766841
019e2a28-a336-756d-999c-376efc4bb9de	019e2a28-a329-7195-8405-1c02642c8bfd	default	opportunities	Mid-market expansion via inside sales	Companies with 50–200 employees are underserved by current self-serve motion. A 3-person inside sales team could add 40–60K MRR within 6 months. Confidence 84%. Est. value: $60,000. Category: growth.	0.84	f	opportunities	019e2a13-9e26-766b-afc4-a2dfa48dc4ad	Opportunity: Mid-market expansion via inside sales	f	\N	\N	\N	90	{"status": "evaluating", "category": "growth", "valuePotential": 60000}	1778823766841
019e2a28-a336-756d-999c-383d0c10e078	019e2a28-a329-7195-8405-1c02642c8bfd	default	opportunities	AI-powered onboarding automation	Replace the 5-step manual onboarding checklist with an AI guide that adapts to user role and industry, projected to cut time-to-value from 14 days to 4. Confidence 78%. Est. value: $28,000. Category: retention.	0.78	f	opportunities	019e2a13-9e26-766b-afc4-a53ca2fa625b	Opportunity: AI-powered onboarding automation	f	\N	\N	\N	80	{"status": "identified", "category": "retention", "valuePotential": 28000}	1778823766841
019e2a28-b6b3-72c8-9980-55cf28ff417b	019e2a28-b69e-7756-84cd-d5631c2cd868	default	top_priorities	High risk: Key account renewal at risk	Severity critical, risk score 65%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	95	{"severity": "critical", "riskScore": 0.65}	1778823771830
019e2a28-a336-756d-999c-3f7356f2aa91	019e2a28-a329-7195-8405-1c02642c8bfd	default	opportunities	Annual plan upsell campaign	Target the 340 monthly subscribers with >6 months tenure for an annual plan migration. Projected to lock in 1.4M ARR and reduce churn exposure. Confidence 88%. Est. value: $42,000. Category: monetization.	0.88	f	opportunities	019e2a13-9e26-766b-afc4-ae7aa314c1b4	Opportunity: Annual plan upsell campaign	f	\N	\N	\N	75	{"status": "identified", "category": "monetization", "valuePotential": 42000}	1778823766841
019e2a28-a336-756d-999c-411ad71767a8	019e2a28-a329-7195-8405-1c02642c8bfd	default	opportunities	Beta Ventures fintech integration	Beta Ventures needs a real-time transaction categorisation API. Building this as a paid add-on could serve the broader fintech vertical. Confidence 65%. Est. value: $15,000. Category: product.	0.65	t	opportunities	019e2a13-9e26-766b-afc4-b2b8f46c691f	Opportunity: Beta Ventures fintech integration	f	\N	\N	\N	55	{"status": "identified", "category": "product", "valuePotential": 15000}	1778823766841
019e2a28-a335-70a0-8420-29034d3f7b13	019e2a28-a329-7195-8405-1c02642c8bfd	default	next_actions	Gamma partnership = 12K user distribution opportunity	Partnership with Gamma Analytics could unlock distribution to 12K enterprise users at near-zero CAC.	0.75	f	memories	019e2a13-9e1a-7209-9267-5b79142c257d	Memory (briefing)	f	\N	\N	\N	65	{"tags": ["partnerships", "distribution", "gamma"], "memorySource": "briefing"}	1778823766841
019e2a28-a335-70a0-8420-2ddaafec2319	019e2a28-a329-7195-8405-1c02642c8bfd	default	next_actions	AI roadmap accelerated; mobile deferred to Q3	Decided to accelerate the AI feature roadmap and deprioritize the mobile app rewrite until Q3.	1	f	memories	019e2a13-9e1a-7209-9267-4dbc29b95aab	Memory (meeting)	f	\N	\N	\N	80	{"tags": ["strategy", "roadmap", "ai"], "memorySource": "meeting"}	1778823766841
019e2a28-a335-70a0-8420-31ace799bdca	019e2a28-a329-7195-8405-1c02642c8bfd	default	next_actions	250K MRR by Q2 2026	Reach 250K MRR by end of Q2 2026 by expanding into mid-market accounts.	0.9	f	memories	019e2a13-9e1a-7209-9267-57cc1d3e6896	Memory (planning)	f	\N	\N	\N	74	{"tags": ["goal", "mrr", "mid-market"], "memorySource": "planning"}	1778823766841
019e2a28-a335-70a0-8420-37f914ea6259	019e2a28-a329-7195-8405-1c02642c8bfd	default	next_actions	Milestone-triggered outbound 2.3x more effective	Outbound campaigns perform 2.3x better when triggered within 24h of a product usage milestone.	0.88	f	memories	019e2a13-9e1a-7209-9267-535e1112e616	Memory (experiment)	f	\N	\N	\N	73	{"tags": ["sales", "outbound", "timing"], "memorySource": "experiment"}	1778823766841
019e2a28-a338-7111-8135-e6317995e013	019e2a28-a329-7195-8405-1c02642c8bfd	default	next_actions	Revenue concentration risk: top 5 accounts = 38% of MRR	Five enterprise accounts contribute 38% of total MRR. If any two churn simultaneously, monthly revenue drops by more than 15%. Recommend accelerating mid-market diversification to reduce concentration below 25% by Q3.	0.93	f	insights	019e2a13-9e34-75dd-bcc5-ce35d8e684b2	Insight (revenue)	f	\N	\N	\N	77	{"category": "revenue", "insightSource": "ai-analyst"}	1778823766841
019e2a28-a338-7111-8135-ebe4b225792b	019e2a28-a329-7195-8405-1c02642c8bfd	default	next_actions	AI workflow usage correlates with 2.1x higher NPS	Accounts actively using AI-generated briefings (≥3 per week) report an average NPS of 81 vs 39 for non-users. This suggests AI features are a primary satisfaction driver and should anchor the renewal and upsell narrative.	0.85	f	insights	019e2a13-9e34-75dd-bcc5-db8f620133f1	Insight (product)	f	\N	\N	\N	73	{"category": "product", "insightSource": "ai-analyst"}	1778823766841
019e2a28-a338-7111-8135-ed936534d6f2	019e2a28-a329-7195-8405-1c02642c8bfd	default	next_actions	Tuesday morning sends outperform Friday sends by 31% in email open rate	Review of 180-day email campaign data shows Tuesday 8–10am sends achieve 31.4% open rates vs 24.1% on Fridays. Scheduling the next pricing campaign for Tuesday 8am is expected to reach 3,200 additional recipients in the active window.	0.81	f	insights	019e2a13-9e34-75dd-bcc5-d79a202d0b21	Insight (marketing)	f	\N	\N	\N	71	{"category": "marketing", "insightSource": "ai-analyst"}	1778823766841
019e2a28-a338-7111-8135-f07a9167029f	019e2a28-a329-7195-8405-1c02642c8bfd	default	next_actions	Opportunity pipeline value increased 48% in the last 30 days	The combined estimated value of opportunities in "identified" and "evaluating" status grew from $148K to $219K over the past 30 days. Top contributors: Gamma Analytics partnership ($120K) and mid-market expansion ($60K). If both convert, H2 revenue targets are materially de-risked.	0.79	f	insights	019e2a13-9e34-75dd-bcc5-deaae426f4e4	Insight (strategic)	f	\N	\N	\N	70	{"category": "strategic", "insightSource": "ai-analyst"}	1778823766841
019e2a28-a497-7043-801e-e0772905f8ca	019e2a28-a48b-764f-8882-2c4f29d249a1	default	top_priorities	High risk: Key account renewal at risk	Severity critical, risk score 65%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	95	{"severity": "critical", "riskScore": 0.65}	1778823767192
019e2a28-a498-722e-b46c-d7007e850d27	019e2a28-a48b-764f-8882-2c4f29d249a1	default	top_priorities	High risk: AI provider rate limit exposure	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823767192
019e2a28-a498-722e-b46c-daa038c53ede	019e2a28-a48b-764f-8882-2c4f29d249a1	default	top_priorities	High risk: Competitor feature parity threat	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823767192
019e2a28-a493-742e-9517-8b566ec61679	019e2a28-a48b-764f-8882-2c4f29d249a1	default	risks	Key account renewal at risk	Three enterprise accounts (combined ARR 210K) have not logged in for 45+ days and renewal dates are within 60 days. Probability 68%, impact 95%. Category: revenue.	0.95	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	65	{"impact": 0.95, "severity": "critical", "probability": 0.68}	1778823767192
019e2a28-a493-742e-9517-8cda2953b777	019e2a28-a48b-764f-8882-2c4f29d249a1	default	risks	AI provider rate limit exposure	Current usage is at 82% of Anthropic tier-2 rate limits. A spike during batch briefing jobs could cause cascading failures. Probability 55%, impact 70%. Category: technical.	0.925	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	39	{"impact": 0.7, "severity": "high", "probability": 0.55}	1778823767192
019e2a28-a493-742e-9517-9125c40ec584	019e2a28-a48b-764f-8882-2c4f29d249a1	default	risks	Competitor feature parity threat	A well-funded competitor released workflow automation in beta. Early reviews indicate feature parity with our core offering within 3–6 months. Probability 60%, impact 65%. Category: competitive.	0.925	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	39	{"impact": 0.65, "severity": "high", "probability": 0.6}	1778823767192
019e2a28-a495-701c-a880-13ce624e1379	019e2a28-a48b-764f-8882-2c4f29d249a1	default	opportunities	Gamma Analytics distribution partnership	Co-sell agreement with Gamma Analytics to offer Acme as a native integration to their 12K enterprise users. Estimated 300–500 qualified leads in year one. Confidence 72%. Est. value: $120,000. Category: partnerships.	0.72	f	opportunities	019e2a13-9e26-766b-afc4-abefa971fb50	Opportunity: Gamma Analytics distribution partnership	f	\N	\N	\N	95	{"status": "evaluating", "category": "partnerships", "valuePotential": 120000}	1778823767192
019e2a28-a495-701c-a880-162ecbbe1c8a	019e2a28-a48b-764f-8882-2c4f29d249a1	default	opportunities	Mid-market expansion via inside sales	Companies with 50–200 employees are underserved by current self-serve motion. A 3-person inside sales team could add 40–60K MRR within 6 months. Confidence 84%. Est. value: $60,000. Category: growth.	0.84	f	opportunities	019e2a13-9e26-766b-afc4-a2dfa48dc4ad	Opportunity: Mid-market expansion via inside sales	f	\N	\N	\N	90	{"status": "evaluating", "category": "growth", "valuePotential": 60000}	1778823767192
019e2a28-a495-701c-a880-1a49f6868de4	019e2a28-a48b-764f-8882-2c4f29d249a1	default	opportunities	AI-powered onboarding automation	Replace the 5-step manual onboarding checklist with an AI guide that adapts to user role and industry, projected to cut time-to-value from 14 days to 4. Confidence 78%. Est. value: $28,000. Category: retention.	0.78	f	opportunities	019e2a13-9e26-766b-afc4-a53ca2fa625b	Opportunity: AI-powered onboarding automation	f	\N	\N	\N	80	{"status": "identified", "category": "retention", "valuePotential": 28000}	1778823767192
019e2a28-a495-701c-a880-1da1973cd1c6	019e2a28-a48b-764f-8882-2c4f29d249a1	default	opportunities	Annual plan upsell campaign	Target the 340 monthly subscribers with >6 months tenure for an annual plan migration. Projected to lock in 1.4M ARR and reduce churn exposure. Confidence 88%. Est. value: $42,000. Category: monetization.	0.88	f	opportunities	019e2a13-9e26-766b-afc4-ae7aa314c1b4	Opportunity: Annual plan upsell campaign	f	\N	\N	\N	75	{"status": "identified", "category": "monetization", "valuePotential": 42000}	1778823767192
019e2a28-a495-701c-a880-20f14ae5d531	019e2a28-a48b-764f-8882-2c4f29d249a1	default	opportunities	Beta Ventures fintech integration	Beta Ventures needs a real-time transaction categorisation API. Building this as a paid add-on could serve the broader fintech vertical. Confidence 65%. Est. value: $15,000. Category: product.	0.65	t	opportunities	019e2a13-9e26-766b-afc4-b2b8f46c691f	Opportunity: Beta Ventures fintech integration	f	\N	\N	\N	55	{"status": "identified", "category": "product", "valuePotential": 15000}	1778823767192
019e2a28-a495-701c-a880-25a680bf91d5	019e2a28-a48b-764f-8882-2c4f29d249a1	default	next_actions	Gamma partnership = 12K user distribution opportunity	Partnership with Gamma Analytics could unlock distribution to 12K enterprise users at near-zero CAC.	0.75	f	memories	019e2a13-9e1a-7209-9267-5b79142c257d	Memory (briefing)	f	\N	\N	\N	65	{"tags": ["partnerships", "distribution", "gamma"], "memorySource": "briefing"}	1778823767192
019e2a28-a495-701c-a880-29d185e28d3f	019e2a28-a48b-764f-8882-2c4f29d249a1	default	next_actions	AI roadmap accelerated; mobile deferred to Q3	Decided to accelerate the AI feature roadmap and deprioritize the mobile app rewrite until Q3.	1	f	memories	019e2a13-9e1a-7209-9267-4dbc29b95aab	Memory (meeting)	f	\N	\N	\N	80	{"tags": ["strategy", "roadmap", "ai"], "memorySource": "meeting"}	1778823767192
019e2a28-a495-701c-a880-2c146a24c841	019e2a28-a48b-764f-8882-2c4f29d249a1	default	next_actions	250K MRR by Q2 2026	Reach 250K MRR by end of Q2 2026 by expanding into mid-market accounts.	0.9	f	memories	019e2a13-9e1a-7209-9267-57cc1d3e6896	Memory (planning)	f	\N	\N	\N	74	{"tags": ["goal", "mrr", "mid-market"], "memorySource": "planning"}	1778823767192
019e2a28-a495-701c-a880-3005485c6e34	019e2a28-a48b-764f-8882-2c4f29d249a1	default	next_actions	Milestone-triggered outbound 2.3x more effective	Outbound campaigns perform 2.3x better when triggered within 24h of a product usage milestone.	0.88	f	memories	019e2a13-9e1a-7209-9267-535e1112e616	Memory (experiment)	f	\N	\N	\N	73	{"tags": ["sales", "outbound", "timing"], "memorySource": "experiment"}	1778823767192
019e2a28-a498-722e-b46c-dc369d1c7e62	019e2a28-a48b-764f-8882-2c4f29d249a1	default	next_actions	Revenue concentration risk: top 5 accounts = 38% of MRR	Five enterprise accounts contribute 38% of total MRR. If any two churn simultaneously, monthly revenue drops by more than 15%. Recommend accelerating mid-market diversification to reduce concentration below 25% by Q3.	0.93	f	insights	019e2a13-9e34-75dd-bcc5-ce35d8e684b2	Insight (revenue)	f	\N	\N	\N	77	{"category": "revenue", "insightSource": "ai-analyst"}	1778823767192
019e2a28-a498-722e-b46c-e2a68ca9097f	019e2a28-a48b-764f-8882-2c4f29d249a1	default	next_actions	AI workflow usage correlates with 2.1x higher NPS	Accounts actively using AI-generated briefings (≥3 per week) report an average NPS of 81 vs 39 for non-users. This suggests AI features are a primary satisfaction driver and should anchor the renewal and upsell narrative.	0.85	f	insights	019e2a13-9e34-75dd-bcc5-db8f620133f1	Insight (product)	f	\N	\N	\N	73	{"category": "product", "insightSource": "ai-analyst"}	1778823767192
019e2a28-a498-722e-b46c-e4bb40a5c3aa	019e2a28-a48b-764f-8882-2c4f29d249a1	default	next_actions	Tuesday morning sends outperform Friday sends by 31% in email open rate	Review of 180-day email campaign data shows Tuesday 8–10am sends achieve 31.4% open rates vs 24.1% on Fridays. Scheduling the next pricing campaign for Tuesday 8am is expected to reach 3,200 additional recipients in the active window.	0.81	f	insights	019e2a13-9e34-75dd-bcc5-d79a202d0b21	Insight (marketing)	f	\N	\N	\N	71	{"category": "marketing", "insightSource": "ai-analyst"}	1778823767192
019e2a28-a498-722e-b46c-e876b1e4e6e7	019e2a28-a48b-764f-8882-2c4f29d249a1	default	next_actions	Opportunity pipeline value increased 48% in the last 30 days	The combined estimated value of opportunities in "identified" and "evaluating" status grew from $148K to $219K over the past 30 days. Top contributors: Gamma Analytics partnership ($120K) and mid-market expansion ($60K). If both convert, H2 revenue targets are materially de-risked.	0.79	f	insights	019e2a13-9e34-75dd-bcc5-deaae426f4e4	Insight (strategic)	f	\N	\N	\N	70	{"category": "strategic", "insightSource": "ai-analyst"}	1778823767192
019e2a28-f52c-7599-b444-8d333ca1f6a6	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	top_priorities	High risk: Key account renewal at risk	Severity critical, risk score 65%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	95	{"severity": "critical", "riskScore": 0.65}	1778823787821
019e2a28-f52c-7599-b444-901f0e04323e	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	top_priorities	High risk: AI provider rate limit exposure	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823787821
019e2a28-f52c-7599-b444-964bfb2b87f2	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	top_priorities	High risk: Competitor feature parity threat	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823787821
019e2a28-b6b3-72c8-9980-5b3aa9f7fef7	019e2a28-b69e-7756-84cd-d5631c2cd868	default	top_priorities	High risk: AI provider rate limit exposure	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823771830
019e2a28-b6b3-72c8-9980-5c4e6a0b2410	019e2a28-b69e-7756-84cd-d5631c2cd868	default	top_priorities	High risk: Competitor feature parity threat	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823771830
019e2a28-b6ae-7388-8f84-48bdf00ef46e	019e2a28-b69e-7756-84cd-d5631c2cd868	default	risks	Key account renewal at risk	Three enterprise accounts (combined ARR 210K) have not logged in for 45+ days and renewal dates are within 60 days. Probability 68%, impact 95%. Category: revenue.	0.95	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	65	{"impact": 0.95, "severity": "critical", "probability": 0.68}	1778823771830
019e2a28-b6ae-7388-8f84-4dd68b280c14	019e2a28-b69e-7756-84cd-d5631c2cd868	default	risks	AI provider rate limit exposure	Current usage is at 82% of Anthropic tier-2 rate limits. A spike during batch briefing jobs could cause cascading failures. Probability 55%, impact 70%. Category: technical.	0.925	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	39	{"impact": 0.7, "severity": "high", "probability": 0.55}	1778823771830
019e2a28-b6ae-7388-8f84-531bd62c4460	019e2a28-b69e-7756-84cd-d5631c2cd868	default	risks	Competitor feature parity threat	A well-funded competitor released workflow automation in beta. Early reviews indicate feature parity with our core offering within 3–6 months. Probability 60%, impact 65%. Category: competitive.	0.925	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	39	{"impact": 0.65, "severity": "high", "probability": 0.6}	1778823771830
019e2a28-b6b1-72f8-971e-22f86154fa85	019e2a28-b69e-7756-84cd-d5631c2cd868	default	opportunities	Gamma Analytics distribution partnership	Co-sell agreement with Gamma Analytics to offer Acme as a native integration to their 12K enterprise users. Estimated 300–500 qualified leads in year one. Confidence 72%. Est. value: $120,000. Category: partnerships.	0.72	f	opportunities	019e2a13-9e26-766b-afc4-abefa971fb50	Opportunity: Gamma Analytics distribution partnership	f	\N	\N	\N	95	{"status": "evaluating", "category": "partnerships", "valuePotential": 120000}	1778823771830
019e2a28-b6b1-72f8-971e-27807d3fdf24	019e2a28-b69e-7756-84cd-d5631c2cd868	default	opportunities	Mid-market expansion via inside sales	Companies with 50–200 employees are underserved by current self-serve motion. A 3-person inside sales team could add 40–60K MRR within 6 months. Confidence 84%. Est. value: $60,000. Category: growth.	0.84	f	opportunities	019e2a13-9e26-766b-afc4-a2dfa48dc4ad	Opportunity: Mid-market expansion via inside sales	f	\N	\N	\N	90	{"status": "evaluating", "category": "growth", "valuePotential": 60000}	1778823771830
019e2a28-b6b1-72f8-971e-2acf0d9f9fc3	019e2a28-b69e-7756-84cd-d5631c2cd868	default	opportunities	AI-powered onboarding automation	Replace the 5-step manual onboarding checklist with an AI guide that adapts to user role and industry, projected to cut time-to-value from 14 days to 4. Confidence 78%. Est. value: $28,000. Category: retention.	0.78	f	opportunities	019e2a13-9e26-766b-afc4-a53ca2fa625b	Opportunity: AI-powered onboarding automation	f	\N	\N	\N	80	{"status": "identified", "category": "retention", "valuePotential": 28000}	1778823771830
019e2a28-b6b1-72f8-971e-2e83a658f793	019e2a28-b69e-7756-84cd-d5631c2cd868	default	opportunities	Annual plan upsell campaign	Target the 340 monthly subscribers with >6 months tenure for an annual plan migration. Projected to lock in 1.4M ARR and reduce churn exposure. Confidence 88%. Est. value: $42,000. Category: monetization.	0.88	f	opportunities	019e2a13-9e26-766b-afc4-ae7aa314c1b4	Opportunity: Annual plan upsell campaign	f	\N	\N	\N	75	{"status": "identified", "category": "monetization", "valuePotential": 42000}	1778823771830
019e2a28-b6b1-72f8-971e-3336b1c95755	019e2a28-b69e-7756-84cd-d5631c2cd868	default	opportunities	Beta Ventures fintech integration	Beta Ventures needs a real-time transaction categorisation API. Building this as a paid add-on could serve the broader fintech vertical. Confidence 65%. Est. value: $15,000. Category: product.	0.65	t	opportunities	019e2a13-9e26-766b-afc4-b2b8f46c691f	Opportunity: Beta Ventures fintech integration	f	\N	\N	\N	55	{"status": "identified", "category": "product", "valuePotential": 15000}	1778823771830
019e2a28-b6b2-74ac-8a8c-5d85f31daa98	019e2a28-b69e-7756-84cd-d5631c2cd868	default	next_actions	Gamma partnership = 12K user distribution opportunity	Partnership with Gamma Analytics could unlock distribution to 12K enterprise users at near-zero CAC.	0.75	f	memories	019e2a13-9e1a-7209-9267-5b79142c257d	Memory (briefing)	f	\N	\N	\N	65	{"tags": ["partnerships", "distribution", "gamma"], "memorySource": "briefing"}	1778823771830
019e2a28-b6b2-74ac-8a8c-6114eb2cc40e	019e2a28-b69e-7756-84cd-d5631c2cd868	default	next_actions	AI roadmap accelerated; mobile deferred to Q3	Decided to accelerate the AI feature roadmap and deprioritize the mobile app rewrite until Q3.	1	f	memories	019e2a13-9e1a-7209-9267-4dbc29b95aab	Memory (meeting)	f	\N	\N	\N	80	{"tags": ["strategy", "roadmap", "ai"], "memorySource": "meeting"}	1778823771830
019e2a28-b6b2-74ac-8a8c-640c3a7234a3	019e2a28-b69e-7756-84cd-d5631c2cd868	default	next_actions	250K MRR by Q2 2026	Reach 250K MRR by end of Q2 2026 by expanding into mid-market accounts.	0.9	f	memories	019e2a13-9e1a-7209-9267-57cc1d3e6896	Memory (planning)	f	\N	\N	\N	74	{"tags": ["goal", "mrr", "mid-market"], "memorySource": "planning"}	1778823771830
019e2a28-b6b2-74ac-8a8c-69f728cb20fd	019e2a28-b69e-7756-84cd-d5631c2cd868	default	next_actions	Milestone-triggered outbound 2.3x more effective	Outbound campaigns perform 2.3x better when triggered within 24h of a product usage milestone.	0.88	f	memories	019e2a13-9e1a-7209-9267-535e1112e616	Memory (experiment)	f	\N	\N	\N	73	{"tags": ["sales", "outbound", "timing"], "memorySource": "experiment"}	1778823771830
019e2a28-b6b5-7529-9fed-9f46c5682aca	019e2a28-b69e-7756-84cd-d5631c2cd868	default	next_actions	Revenue concentration risk: top 5 accounts = 38% of MRR	Five enterprise accounts contribute 38% of total MRR. If any two churn simultaneously, monthly revenue drops by more than 15%. Recommend accelerating mid-market diversification to reduce concentration below 25% by Q3.	0.93	f	insights	019e2a13-9e34-75dd-bcc5-ce35d8e684b2	Insight (revenue)	f	\N	\N	\N	77	{"category": "revenue", "insightSource": "ai-analyst"}	1778823771830
019e2a28-b6b5-7529-9fed-a3b7991c660f	019e2a28-b69e-7756-84cd-d5631c2cd868	default	next_actions	AI workflow usage correlates with 2.1x higher NPS	Accounts actively using AI-generated briefings (≥3 per week) report an average NPS of 81 vs 39 for non-users. This suggests AI features are a primary satisfaction driver and should anchor the renewal and upsell narrative.	0.85	f	insights	019e2a13-9e34-75dd-bcc5-db8f620133f1	Insight (product)	f	\N	\N	\N	73	{"category": "product", "insightSource": "ai-analyst"}	1778823771830
019e2a28-b6b5-7529-9fed-a6abcb4e078b	019e2a28-b69e-7756-84cd-d5631c2cd868	default	next_actions	Tuesday morning sends outperform Friday sends by 31% in email open rate	Review of 180-day email campaign data shows Tuesday 8–10am sends achieve 31.4% open rates vs 24.1% on Fridays. Scheduling the next pricing campaign for Tuesday 8am is expected to reach 3,200 additional recipients in the active window.	0.81	f	insights	019e2a13-9e34-75dd-bcc5-d79a202d0b21	Insight (marketing)	f	\N	\N	\N	71	{"category": "marketing", "insightSource": "ai-analyst"}	1778823771830
019e2a28-b6b6-70ac-be6f-0ece35c9d926	019e2a28-b69e-7756-84cd-d5631c2cd868	default	next_actions	Opportunity pipeline value increased 48% in the last 30 days	The combined estimated value of opportunities in "identified" and "evaluating" status grew from $148K to $219K over the past 30 days. Top contributors: Gamma Analytics partnership ($120K) and mid-market expansion ($60K). If both convert, H2 revenue targets are materially de-risked.	0.79	f	insights	019e2a13-9e34-75dd-bcc5-deaae426f4e4	Insight (strategic)	f	\N	\N	\N	70	{"category": "strategic", "insightSource": "ai-analyst"}	1778823771830
019e2a28-f527-723c-976f-ab66ddcfd252	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	risks	Key account renewal at risk	Three enterprise accounts (combined ARR 210K) have not logged in for 45+ days and renewal dates are within 60 days. Probability 68%, impact 95%. Category: revenue.	0.95	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	65	{"impact": 0.95, "severity": "critical", "probability": 0.68}	1778823787821
019e2a28-f527-723c-976f-af2f699c11fa	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	risks	AI provider rate limit exposure	Current usage is at 82% of Anthropic tier-2 rate limits. A spike during batch briefing jobs could cause cascading failures. Probability 55%, impact 70%. Category: technical.	0.925	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	39	{"impact": 0.7, "severity": "high", "probability": 0.55}	1778823787821
019e2a28-f527-723c-976f-b28439ab6d03	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	risks	Competitor feature parity threat	A well-funded competitor released workflow automation in beta. Early reviews indicate feature parity with our core offering within 3–6 months. Probability 60%, impact 65%. Category: competitive.	0.925	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	39	{"impact": 0.65, "severity": "high", "probability": 0.6}	1778823787821
019e2a28-f52a-7748-acb6-5fd023060e21	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	opportunities	Gamma Analytics distribution partnership	Co-sell agreement with Gamma Analytics to offer Acme as a native integration to their 12K enterprise users. Estimated 300–500 qualified leads in year one. Confidence 72%. Est. value: $120,000. Category: partnerships.	0.72	f	opportunities	019e2a13-9e26-766b-afc4-abefa971fb50	Opportunity: Gamma Analytics distribution partnership	f	\N	\N	\N	95	{"status": "evaluating", "category": "partnerships", "valuePotential": 120000}	1778823787821
019e2a28-f52a-7748-acb6-62b87703aca8	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	opportunities	Mid-market expansion via inside sales	Companies with 50–200 employees are underserved by current self-serve motion. A 3-person inside sales team could add 40–60K MRR within 6 months. Confidence 84%. Est. value: $60,000. Category: growth.	0.84	f	opportunities	019e2a13-9e26-766b-afc4-a2dfa48dc4ad	Opportunity: Mid-market expansion via inside sales	f	\N	\N	\N	90	{"status": "evaluating", "category": "growth", "valuePotential": 60000}	1778823787821
019e2a28-f52a-7748-acb6-67f57d1286f3	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	opportunities	AI-powered onboarding automation	Replace the 5-step manual onboarding checklist with an AI guide that adapts to user role and industry, projected to cut time-to-value from 14 days to 4. Confidence 78%. Est. value: $28,000. Category: retention.	0.78	f	opportunities	019e2a13-9e26-766b-afc4-a53ca2fa625b	Opportunity: AI-powered onboarding automation	f	\N	\N	\N	80	{"status": "identified", "category": "retention", "valuePotential": 28000}	1778823787821
019e2a28-f52a-7748-acb6-69c25fe1b722	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	opportunities	Annual plan upsell campaign	Target the 340 monthly subscribers with >6 months tenure for an annual plan migration. Projected to lock in 1.4M ARR and reduce churn exposure. Confidence 88%. Est. value: $42,000. Category: monetization.	0.88	f	opportunities	019e2a13-9e26-766b-afc4-ae7aa314c1b4	Opportunity: Annual plan upsell campaign	f	\N	\N	\N	75	{"status": "identified", "category": "monetization", "valuePotential": 42000}	1778823787821
019e2a28-f52a-7748-acb6-6e3cd487f913	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	opportunities	Beta Ventures fintech integration	Beta Ventures needs a real-time transaction categorisation API. Building this as a paid add-on could serve the broader fintech vertical. Confidence 65%. Est. value: $15,000. Category: product.	0.65	t	opportunities	019e2a13-9e26-766b-afc4-b2b8f46c691f	Opportunity: Beta Ventures fintech integration	f	\N	\N	\N	55	{"status": "identified", "category": "product", "valuePotential": 15000}	1778823787821
019e2a28-f529-762b-a31e-b86625a4e501	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	next_actions	LongRun memory test 4: platform stability at sustained load. Ops platform handle	LongRun memory test 4: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	1	f	memories	019e2a28-f18f-77e7-a89a-723d028ac775	Memory (api)	f	\N	\N	\N	80	{"tags": [], "memorySource": "api"}	1778823787821
019e2a28-f529-762b-a31e-bd7d69bea3dc	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	next_actions	LongRun memory test 3: platform stability at sustained load. Ops platform handle	LongRun memory test 3: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	1	f	memories	019e2a28-efa9-725a-81ad-8967e621caf9	Memory (api)	f	\N	\N	\N	80	{"tags": [], "memorySource": "api"}	1778823787821
019e2a28-f529-762b-a31e-c0369b929628	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	next_actions	LongRun memory test 2: platform stability at sustained load. Ops platform handle	LongRun memory test 2: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	1	f	memories	019e2a28-edc5-7298-87e9-cae28715a4bb	Memory (api)	f	\N	\N	\N	80	{"tags": [], "memorySource": "api"}	1778823787821
019e2a28-f529-762b-a31e-c7ce43f0fe31	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	next_actions	Gamma partnership = 12K user distribution opportunity	Partnership with Gamma Analytics could unlock distribution to 12K enterprise users at near-zero CAC.	0.75	f	memories	019e2a13-9e1a-7209-9267-5b79142c257d	Memory (briefing)	f	\N	\N	\N	65	{"tags": ["partnerships", "distribution", "gamma"], "memorySource": "briefing"}	1778823787821
019e2a28-f529-762b-a31e-cb7b181a6f6d	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	next_actions	AI roadmap accelerated; mobile deferred to Q3	Decided to accelerate the AI feature roadmap and deprioritize the mobile app rewrite until Q3.	1	f	memories	019e2a13-9e1a-7209-9267-4dbc29b95aab	Memory (meeting)	f	\N	\N	\N	80	{"tags": ["strategy", "roadmap", "ai"], "memorySource": "meeting"}	1778823787821
019e2a28-f52d-7517-ad78-4bb3948c4afb	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	next_actions	Revenue concentration risk: top 5 accounts = 38% of MRR	Five enterprise accounts contribute 38% of total MRR. If any two churn simultaneously, monthly revenue drops by more than 15%. Recommend accelerating mid-market diversification to reduce concentration below 25% by Q3.	0.93	f	insights	019e2a13-9e34-75dd-bcc5-ce35d8e684b2	Insight (revenue)	f	\N	\N	\N	77	{"category": "revenue", "insightSource": "ai-analyst"}	1778823787821
019e2a28-f52d-7517-ad78-4f94f4a547c7	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	next_actions	AI workflow usage correlates with 2.1x higher NPS	Accounts actively using AI-generated briefings (≥3 per week) report an average NPS of 81 vs 39 for non-users. This suggests AI features are a primary satisfaction driver and should anchor the renewal and upsell narrative.	0.85	f	insights	019e2a13-9e34-75dd-bcc5-db8f620133f1	Insight (product)	f	\N	\N	\N	73	{"category": "product", "insightSource": "ai-analyst"}	1778823787821
019e2a28-f52d-7517-ad78-503c94f6c340	019e2a28-f51d-71bb-912b-5f81c63b9f71	default	next_actions	Tuesday morning sends outperform Friday sends by 31% in email open rate	Review of 180-day email campaign data shows Tuesday 8–10am sends achieve 31.4% open rates vs 24.1% on Fridays. Scheduling the next pricing campaign for Tuesday 8am is expected to reach 3,200 additional recipients in the active window.	0.81	f	insights	019e2a13-9e34-75dd-bcc5-d79a202d0b21	Insight (marketing)	f	\N	\N	\N	71	{"category": "marketing", "insightSource": "ai-analyst"}	1778823787821
019e2a28-f6da-76c6-8b6f-7dbf9401b12d	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	top_priorities	High risk: Key account renewal at risk	Severity critical, risk score 65%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	95	{"severity": "critical", "riskScore": 0.65}	1778823788251
019e2a28-f6da-76c6-8b6f-82e853d54b23	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	top_priorities	High risk: AI provider rate limit exposure	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823788251
019e2a28-f6da-76c6-8b6f-853f236240de	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	top_priorities	High risk: Competitor feature parity threat	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823788251
019e2a28-f6d3-7139-88a5-6837181734ba	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	risks	Key account renewal at risk	Three enterprise accounts (combined ARR 210K) have not logged in for 45+ days and renewal dates are within 60 days. Probability 68%, impact 95%. Category: revenue.	0.95	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	65	{"impact": 0.95, "severity": "critical", "probability": 0.68}	1778823788251
019e2a28-f6d3-7139-88a5-6cc139d3ae89	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	risks	AI provider rate limit exposure	Current usage is at 82% of Anthropic tier-2 rate limits. A spike during batch briefing jobs could cause cascading failures. Probability 55%, impact 70%. Category: technical.	0.925	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	39	{"impact": 0.7, "severity": "high", "probability": 0.55}	1778823788251
019e2a28-f6d3-7139-88a5-7095f9804ff3	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	risks	Competitor feature parity threat	A well-funded competitor released workflow automation in beta. Early reviews indicate feature parity with our core offering within 3–6 months. Probability 60%, impact 65%. Category: competitive.	0.925	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	39	{"impact": 0.65, "severity": "high", "probability": 0.6}	1778823788251
019e2a28-f6d7-7330-8a7f-93741237ea47	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	opportunities	Gamma Analytics distribution partnership	Co-sell agreement with Gamma Analytics to offer Acme as a native integration to their 12K enterprise users. Estimated 300–500 qualified leads in year one. Confidence 72%. Est. value: $120,000. Category: partnerships.	0.72	f	opportunities	019e2a13-9e26-766b-afc4-abefa971fb50	Opportunity: Gamma Analytics distribution partnership	f	\N	\N	\N	95	{"status": "evaluating", "category": "partnerships", "valuePotential": 120000}	1778823788251
019e2a28-f6d7-7330-8a7f-96cf93259398	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	opportunities	Mid-market expansion via inside sales	Companies with 50–200 employees are underserved by current self-serve motion. A 3-person inside sales team could add 40–60K MRR within 6 months. Confidence 84%. Est. value: $60,000. Category: growth.	0.84	f	opportunities	019e2a13-9e26-766b-afc4-a2dfa48dc4ad	Opportunity: Mid-market expansion via inside sales	f	\N	\N	\N	90	{"status": "evaluating", "category": "growth", "valuePotential": 60000}	1778823788251
019e2a28-f6d7-7330-8a7f-9a52aa0d478a	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	opportunities	AI-powered onboarding automation	Replace the 5-step manual onboarding checklist with an AI guide that adapts to user role and industry, projected to cut time-to-value from 14 days to 4. Confidence 78%. Est. value: $28,000. Category: retention.	0.78	f	opportunities	019e2a13-9e26-766b-afc4-a53ca2fa625b	Opportunity: AI-powered onboarding automation	f	\N	\N	\N	80	{"status": "identified", "category": "retention", "valuePotential": 28000}	1778823788251
019e2a28-f6d7-7330-8a7f-9d44fc4f7409	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	opportunities	Annual plan upsell campaign	Target the 340 monthly subscribers with >6 months tenure for an annual plan migration. Projected to lock in 1.4M ARR and reduce churn exposure. Confidence 88%. Est. value: $42,000. Category: monetization.	0.88	f	opportunities	019e2a13-9e26-766b-afc4-ae7aa314c1b4	Opportunity: Annual plan upsell campaign	f	\N	\N	\N	75	{"status": "identified", "category": "monetization", "valuePotential": 42000}	1778823788251
019e2a28-f6d7-7330-8a7f-a0abd6a451c3	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	opportunities	Beta Ventures fintech integration	Beta Ventures needs a real-time transaction categorisation API. Building this as a paid add-on could serve the broader fintech vertical. Confidence 65%. Est. value: $15,000. Category: product.	0.65	t	opportunities	019e2a13-9e26-766b-afc4-b2b8f46c691f	Opportunity: Beta Ventures fintech integration	f	\N	\N	\N	55	{"status": "identified", "category": "product", "valuePotential": 15000}	1778823788251
019e2a28-f6d8-748f-b9a0-15e95b064d60	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	next_actions	LongRun memory test 4: platform stability at sustained load. Ops platform handle	LongRun memory test 4: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	1	f	memories	019e2a28-f18f-77e7-a89a-723d028ac775	Memory (api)	f	\N	\N	\N	80	{"tags": [], "memorySource": "api"}	1778823788251
019e2a28-f6d8-748f-b9a0-1900be1f0b70	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	next_actions	LongRun memory test 3: platform stability at sustained load. Ops platform handle	LongRun memory test 3: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	1	f	memories	019e2a28-efa9-725a-81ad-8967e621caf9	Memory (api)	f	\N	\N	\N	80	{"tags": [], "memorySource": "api"}	1778823788251
019e2a28-f6d8-748f-b9a0-1e50ce662575	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	next_actions	LongRun memory test 2: platform stability at sustained load. Ops platform handle	LongRun memory test 2: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	1	f	memories	019e2a28-edc5-7298-87e9-cae28715a4bb	Memory (api)	f	\N	\N	\N	80	{"tags": [], "memorySource": "api"}	1778823788251
019e2a28-f6d8-748f-b9a0-23fa7805cf99	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	next_actions	Gamma partnership = 12K user distribution opportunity	Partnership with Gamma Analytics could unlock distribution to 12K enterprise users at near-zero CAC.	0.75	f	memories	019e2a13-9e1a-7209-9267-5b79142c257d	Memory (briefing)	f	\N	\N	\N	65	{"tags": ["partnerships", "distribution", "gamma"], "memorySource": "briefing"}	1778823788251
019e2a28-f6d8-748f-b9a0-27b6fac6af16	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	next_actions	AI roadmap accelerated; mobile deferred to Q3	Decided to accelerate the AI feature roadmap and deprioritize the mobile app rewrite until Q3.	1	f	memories	019e2a13-9e1a-7209-9267-4dbc29b95aab	Memory (meeting)	f	\N	\N	\N	80	{"tags": ["strategy", "roadmap", "ai"], "memorySource": "meeting"}	1778823788251
019e2a28-f6db-77de-ba6f-e9ffed60096a	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	next_actions	Revenue concentration risk: top 5 accounts = 38% of MRR	Five enterprise accounts contribute 38% of total MRR. If any two churn simultaneously, monthly revenue drops by more than 15%. Recommend accelerating mid-market diversification to reduce concentration below 25% by Q3.	0.93	f	insights	019e2a13-9e34-75dd-bcc5-ce35d8e684b2	Insight (revenue)	f	\N	\N	\N	77	{"category": "revenue", "insightSource": "ai-analyst"}	1778823788251
019e2a28-f6db-77de-ba6f-ec63f837f604	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	next_actions	AI workflow usage correlates with 2.1x higher NPS	Accounts actively using AI-generated briefings (≥3 per week) report an average NPS of 81 vs 39 for non-users. This suggests AI features are a primary satisfaction driver and should anchor the renewal and upsell narrative.	0.85	f	insights	019e2a13-9e34-75dd-bcc5-db8f620133f1	Insight (product)	f	\N	\N	\N	73	{"category": "product", "insightSource": "ai-analyst"}	1778823788251
019e2a28-f6db-77de-ba6f-f304bfc076ed	019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	next_actions	Tuesday morning sends outperform Friday sends by 31% in email open rate	Review of 180-day email campaign data shows Tuesday 8–10am sends achieve 31.4% open rates vs 24.1% on Fridays. Scheduling the next pricing campaign for Tuesday 8am is expected to reach 3,200 additional recipients in the active window.	0.81	f	insights	019e2a13-9e34-75dd-bcc5-d79a202d0b21	Insight (marketing)	f	\N	\N	\N	71	{"category": "marketing", "insightSource": "ai-analyst"}	1778823788251
019e2a28-f8a7-7512-b916-0f29c584604a	019e2a28-f89b-753c-b466-baa697b94b20	default	top_priorities	High risk: Key account renewal at risk	Severity critical, risk score 65%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	95	{"severity": "critical", "riskScore": 0.65}	1778823788713
019e2a28-f8a7-7512-b916-12242d4da6a2	019e2a28-f89b-753c-b466-baa697b94b20	default	top_priorities	High risk: AI provider rate limit exposure	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823788713
019e2a28-f8a7-7512-b916-143a115b1b1f	019e2a28-f89b-753c-b466-baa697b94b20	default	top_priorities	High risk: Competitor feature parity threat	Severity high, risk score 39%.	0.85	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	80	{"severity": "high", "riskScore": 0.39}	1778823788713
019e2a28-f8a4-7679-82f0-ca7fc8b72441	019e2a28-f89b-753c-b466-baa697b94b20	default	risks	Key account renewal at risk	Three enterprise accounts (combined ARR 210K) have not logged in for 45+ days and renewal dates are within 60 days. Probability 68%, impact 95%. Category: revenue.	0.95	f	risks	019e2a13-9e2b-760c-ab64-52e3c9a409db	Risk: Key account renewal at risk	f	\N	\N	\N	65	{"impact": 0.95, "severity": "critical", "probability": 0.68}	1778823788713
019e2a28-f8a4-7679-82f0-cecdc2ba0ef3	019e2a28-f89b-753c-b466-baa697b94b20	default	risks	AI provider rate limit exposure	Current usage is at 82% of Anthropic tier-2 rate limits. A spike during batch briefing jobs could cause cascading failures. Probability 55%, impact 70%. Category: technical.	0.925	f	risks	019e2a13-9e2b-760c-ab64-56d846d3d9cc	Risk: AI provider rate limit exposure	f	\N	\N	\N	39	{"impact": 0.7, "severity": "high", "probability": 0.55}	1778823788713
019e2a28-f8a4-7679-82f0-d330736260ec	019e2a28-f89b-753c-b466-baa697b94b20	default	risks	Competitor feature parity threat	A well-funded competitor released workflow automation in beta. Early reviews indicate feature parity with our core offering within 3–6 months. Probability 60%, impact 65%. Category: competitive.	0.925	f	risks	019e2a13-9e2b-760c-ab64-5ed660dd9d36	Risk: Competitor feature parity threat	f	\N	\N	\N	39	{"impact": 0.65, "severity": "high", "probability": 0.6}	1778823788713
019e2a28-f8a5-737d-a98f-057e2fca00f3	019e2a28-f89b-753c-b466-baa697b94b20	default	opportunities	Gamma Analytics distribution partnership	Co-sell agreement with Gamma Analytics to offer Acme as a native integration to their 12K enterprise users. Estimated 300–500 qualified leads in year one. Confidence 72%. Est. value: $120,000. Category: partnerships.	0.72	f	opportunities	019e2a13-9e26-766b-afc4-abefa971fb50	Opportunity: Gamma Analytics distribution partnership	f	\N	\N	\N	95	{"status": "evaluating", "category": "partnerships", "valuePotential": 120000}	1778823788713
019e2a28-f8a5-737d-a98f-0a4628f7caeb	019e2a28-f89b-753c-b466-baa697b94b20	default	opportunities	Mid-market expansion via inside sales	Companies with 50–200 employees are underserved by current self-serve motion. A 3-person inside sales team could add 40–60K MRR within 6 months. Confidence 84%. Est. value: $60,000. Category: growth.	0.84	f	opportunities	019e2a13-9e26-766b-afc4-a2dfa48dc4ad	Opportunity: Mid-market expansion via inside sales	f	\N	\N	\N	90	{"status": "evaluating", "category": "growth", "valuePotential": 60000}	1778823788713
019e2a28-f8a5-737d-a98f-0d7a749fb994	019e2a28-f89b-753c-b466-baa697b94b20	default	opportunities	AI-powered onboarding automation	Replace the 5-step manual onboarding checklist with an AI guide that adapts to user role and industry, projected to cut time-to-value from 14 days to 4. Confidence 78%. Est. value: $28,000. Category: retention.	0.78	f	opportunities	019e2a13-9e26-766b-afc4-a53ca2fa625b	Opportunity: AI-powered onboarding automation	f	\N	\N	\N	80	{"status": "identified", "category": "retention", "valuePotential": 28000}	1778823788713
019e2a28-f8a5-737d-a98f-107bed83674b	019e2a28-f89b-753c-b466-baa697b94b20	default	opportunities	Annual plan upsell campaign	Target the 340 monthly subscribers with >6 months tenure for an annual plan migration. Projected to lock in 1.4M ARR and reduce churn exposure. Confidence 88%. Est. value: $42,000. Category: monetization.	0.88	f	opportunities	019e2a13-9e26-766b-afc4-ae7aa314c1b4	Opportunity: Annual plan upsell campaign	f	\N	\N	\N	75	{"status": "identified", "category": "monetization", "valuePotential": 42000}	1778823788713
019e2a28-f8a5-737d-a98f-17ce172e3906	019e2a28-f89b-753c-b466-baa697b94b20	default	opportunities	Beta Ventures fintech integration	Beta Ventures needs a real-time transaction categorisation API. Building this as a paid add-on could serve the broader fintech vertical. Confidence 65%. Est. value: $15,000. Category: product.	0.65	t	opportunities	019e2a13-9e26-766b-afc4-b2b8f46c691f	Opportunity: Beta Ventures fintech integration	f	\N	\N	\N	55	{"status": "identified", "category": "product", "valuePotential": 15000}	1778823788713
019e2a28-f8a5-737d-a98f-182442d70775	019e2a28-f89b-753c-b466-baa697b94b20	default	next_actions	LongRun memory test 4: platform stability at sustained load. Ops platform handle	LongRun memory test 4: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	1	f	memories	019e2a28-f18f-77e7-a89a-723d028ac775	Memory (api)	f	\N	\N	\N	80	{"tags": [], "memorySource": "api"}	1778823788713
019e2a28-f8a5-737d-a98f-1d3891c5d729	019e2a28-f89b-753c-b466-baa697b94b20	default	next_actions	LongRun memory test 3: platform stability at sustained load. Ops platform handle	LongRun memory test 3: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	1	f	memories	019e2a28-efa9-725a-81ad-8967e621caf9	Memory (api)	f	\N	\N	\N	80	{"tags": [], "memorySource": "api"}	1778823788713
019e2a28-f8a5-737d-a98f-22bde7437d47	019e2a28-f89b-753c-b466-baa697b94b20	default	next_actions	LongRun memory test 2: platform stability at sustained load. Ops platform handle	LongRun memory test 2: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	1	f	memories	019e2a28-edc5-7298-87e9-cae28715a4bb	Memory (api)	f	\N	\N	\N	80	{"tags": [], "memorySource": "api"}	1778823788713
019e2a28-f8a5-737d-a98f-2614b705a368	019e2a28-f89b-753c-b466-baa697b94b20	default	next_actions	Gamma partnership = 12K user distribution opportunity	Partnership with Gamma Analytics could unlock distribution to 12K enterprise users at near-zero CAC.	0.75	f	memories	019e2a13-9e1a-7209-9267-5b79142c257d	Memory (briefing)	f	\N	\N	\N	65	{"tags": ["partnerships", "distribution", "gamma"], "memorySource": "briefing"}	1778823788713
019e2a28-f8a5-737d-a98f-2bc35e968d5e	019e2a28-f89b-753c-b466-baa697b94b20	default	next_actions	AI roadmap accelerated; mobile deferred to Q3	Decided to accelerate the AI feature roadmap and deprioritize the mobile app rewrite until Q3.	1	f	memories	019e2a13-9e1a-7209-9267-4dbc29b95aab	Memory (meeting)	f	\N	\N	\N	80	{"tags": ["strategy", "roadmap", "ai"], "memorySource": "meeting"}	1778823788713
019e2a28-f8a8-72b3-816b-00a3d33e3df9	019e2a28-f89b-753c-b466-baa697b94b20	default	next_actions	Revenue concentration risk: top 5 accounts = 38% of MRR	Five enterprise accounts contribute 38% of total MRR. If any two churn simultaneously, monthly revenue drops by more than 15%. Recommend accelerating mid-market diversification to reduce concentration below 25% by Q3.	0.93	f	insights	019e2a13-9e34-75dd-bcc5-ce35d8e684b2	Insight (revenue)	f	\N	\N	\N	77	{"category": "revenue", "insightSource": "ai-analyst"}	1778823788713
019e2a28-f8a8-72b3-816b-07e693464560	019e2a28-f89b-753c-b466-baa697b94b20	default	next_actions	AI workflow usage correlates with 2.1x higher NPS	Accounts actively using AI-generated briefings (≥3 per week) report an average NPS of 81 vs 39 for non-users. This suggests AI features are a primary satisfaction driver and should anchor the renewal and upsell narrative.	0.85	f	insights	019e2a13-9e34-75dd-bcc5-db8f620133f1	Insight (product)	f	\N	\N	\N	73	{"category": "product", "insightSource": "ai-analyst"}	1778823788713
019e2a28-f8a8-72b3-816b-086d7c36d8e5	019e2a28-f89b-753c-b466-baa697b94b20	default	next_actions	Tuesday morning sends outperform Friday sends by 31% in email open rate	Review of 180-day email campaign data shows Tuesday 8–10am sends achieve 31.4% open rates vs 24.1% on Fridays. Scheduling the next pricing campaign for Tuesday 8am is expected to reach 3,200 additional recipients in the active window.	0.81	f	insights	019e2a13-9e34-75dd-bcc5-d79a202d0b21	Insight (marketing)	f	\N	\N	\N	71	{"category": "marketing", "insightSource": "ai-analyst"}	1778823788713
\.


--
-- Data for Name: briefings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.briefings (id, workspace_id, status, requested_by, trace_id, window_ms, summary, error_message, generated_at, created_at) FROM stdin;
019e2a13-9ddf-73e1-ac5c-7beb421c1224	default	ready	system	019e2a13-9e38-77fc-9d95-a76b40002e33	86400000	Strong week overall. Revenue pipeline growing. One critical risk (key account renewals) requires immediate action. AI feature adoption accelerating.	\N	1778390389214	1778390389214
019e2a13-9ddf-73e1-ac5c-7f24d7d80b8c	default	ready	system	019e2a13-9e39-75b8-b638-4e3b2bb1771b	86400000	Steady progress on Q2 goals. Partnership evaluation with Gamma Analytics advancing. Monitor AI rate-limit risk closely. Three workflow runs completed without issues.	\N	1778735989214	1778735989214
019e2a28-a166-70e9-a7ba-f4441c04191c	default	generating	user	019e2a28-a166-70e9-a7ba-f1ece17e0c2c	86400000	\N	\N	\N	1778823766374
019e2a28-a1a0-701c-a8d9-7927204cdb97	default	ready	user	019e2a28-a166-70e9-a7ba-f1ece17e0c2c	86400000	3 top priorities · 0 blocked workflows · 3 open risks · 5 opportunities · 0 recovery items · 8 next actions · 1 low-confidence item	\N	1778823766526	1778823766432
019e2a28-a321-747f-b481-7452cbd52bd2	default	generating	user	019e2a28-a321-747f-b481-71a1d4a95e64	86400000	\N	\N	\N	1778823766817
019e2a28-a329-7195-8405-1c02642c8bfd	default	ready	user	019e2a28-a321-747f-b481-71a1d4a95e64	86400000	3 top priorities · 0 blocked workflows · 3 open risks · 5 opportunities · 0 recovery items · 8 next actions · 1 low-confidence item	\N	1778823766841	1778823766825
019e2a28-a483-76cf-ad55-17bf9d5649e6	default	generating	user	019e2a28-a483-76cf-ad55-107ebb6032ab	86400000	\N	\N	\N	1778823767171
019e2a28-a48b-764f-8882-2c4f29d249a1	default	ready	user	019e2a28-a483-76cf-ad55-107ebb6032ab	86400000	3 top priorities · 0 blocked workflows · 3 open risks · 5 opportunities · 0 recovery items · 8 next actions · 1 low-confidence item	\N	1778823767192	1778823767179
019e2a28-b695-75ef-b9c4-5d922f1a98c0	default	generating	user	019e2a28-b695-75ef-b9c4-59214a110d89	86400000	\N	\N	\N	1778823771797
019e2a28-b69e-7756-84cd-d5631c2cd868	default	ready	user	019e2a28-b695-75ef-b9c4-59214a110d89	86400000	3 top priorities · 0 blocked workflows · 3 open risks · 5 opportunities · 0 recovery items · 8 next actions · 1 low-confidence item	\N	1778823771830	1778823771806
019e2a28-f513-722b-8084-7eae2052714e	default	generating	user	019e2a28-f513-722b-8084-78f834a39239	86400000	\N	\N	\N	1778823787795
019e2a28-f51d-71bb-912b-5f81c63b9f71	default	ready	user	019e2a28-f513-722b-8084-78f834a39239	86400000	3 top priorities · 0 blocked workflows · 3 open risks · 5 opportunities · 0 recovery items · 8 next actions · 1 low-confidence item	\N	1778823787821	1778823787805
019e2a28-f6bf-72c2-b853-97b307204df3	default	generating	user	019e2a28-f6bf-72c2-b853-939cc61da617	86400000	\N	\N	\N	1778823788223
019e2a28-f6c9-758d-b32f-e3fd78d8e2ab	default	ready	user	019e2a28-f6bf-72c2-b853-939cc61da617	86400000	3 top priorities · 0 blocked workflows · 3 open risks · 5 opportunities · 0 recovery items · 8 next actions · 1 low-confidence item	\N	1778823788251	1778823788233
019e2a28-f892-75fd-ba5b-ec2068e86d81	default	generating	user	019e2a28-f892-75fd-ba5b-eb660de55b99	86400000	\N	\N	\N	1778823788690
019e2a28-f89b-753c-b466-baa697b94b20	default	ready	user	019e2a28-f892-75fd-ba5b-eb660de55b99	86400000	3 top priorities · 0 blocked workflows · 3 open risks · 5 opportunities · 0 recovery items · 8 next actions · 1 low-confidence item	\N	1778823788713	1778823788699
\.


--
-- Data for Name: browser_actions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.browser_actions (id, session_id, workspace_id, action_type, action_input, success, output, error, screenshot_path, duration_ms, executed_at) FROM stdin;
\.


--
-- Data for Name: browser_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.browser_sessions (id, workspace_id, job_id, run_id, step_id, trace_id, url, status, page_title, page_text, screenshot_path, error_message, duration_ms, started_at, completed_at, created_at) FROM stdin;
\.


--
-- Data for Name: businesses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.businesses (id, workspace_id, name, domain, industry, stage, health, metrics, metadata, created_at, updated_at) FROM stdin;
019e2a13-9dde-742c-b38a-3ad3b0afdde4	default	Acme Corp	acme.com	SaaS	growth	green	{"mrr": 185000, "nps": 72, "churnRate": 0.02, "activeUsers": 3400}	{"founded": 2019, "employees": 48, "headquarters": "New York, NY"}	1776230389214	1778822389214
019e2a13-9ddf-73e1-ac5c-5cea6a973c99	default	Beta Ventures	betaventures.io	Fintech	early	yellow	{"mrr": 22000, "nps": 51, "churnRate": 0.05, "activeUsers": 410}	{"founded": 2022, "employees": 12, "headquarters": "Austin, TX"}	1777094389214	1778735989214
019e2a13-9ddf-73e1-ac5c-61e9cfb13b3f	default	Gamma Analytics	gammaanalytics.com	Data & Analytics	scale	green	{"mrr": 540000, "nps": 81, "churnRate": 0.01, "activeUsers": 12000}	{"founded": 2017, "employees": 130, "headquarters": "San Francisco, CA"}	1773638389214	1778822389214
\.


--
-- Data for Name: dead_letter_jobs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.dead_letter_jobs (id, queue_name, job_id, job_name, workspace_id, payload, error, attempts, worker_id, trace_id, first_failed_at, dead_lettered_at, replayed_at, replayed_by, replay_run_id) FROM stdin;
019e2a2e-fa7a-72f8-8649-4f73baf9f19c	workflow-runs	019e2a2e-e229-771b-8a5a-f6e0140daf90	executeWorkflowRun	default	{"runId": "019e2a2e-e229-771b-8a5a-f6e0140daf90", "traceId": "019e2a2e-e22a-75d9-8934-8b2f4f063032", "failedStepIds": ["s1"]}	Step s1 failed: HTTP request failed: fetch failed	1	workflow-worker	019e2a2e-e22a-75d9-8934-8b2f4f063032	1778824182394	1778824182394	\N	\N	\N
019e2a2e-fd0e-738c-87b2-d0be1aa36cf4	workflow-runs	019e2a2e-e538-71ad-ac4c-cd60944b1a66	executeWorkflowRun	default	{"runId": "019e2a2e-e538-71ad-ac4c-cd60944b1a66", "traceId": "019e2a2e-e538-71ad-ac4c-d27e3caf9d21", "failedStepIds": ["s1"]}	Step s1 failed: HTTP request failed: fetch failed	1	workflow-worker	019e2a2e-e538-71ad-ac4c-d27e3caf9d21	1778824183054	1778824183054	1778824194228	api	019e2a2f-28b4-767d-9924-e48bdc2f8150
019e2a2e-fc0b-77af-b14d-4687629068b8	workflow-runs	019e2a2e-e3cc-772e-a956-dca340326f4e	executeWorkflowRun	default	{"runId": "019e2a2e-e3cc-772e-a956-dca340326f4e", "traceId": "019e2a2e-e3cc-772e-a956-e2ba924719bb", "failedStepIds": ["s1"]}	Step s1 failed: HTTP request failed: fetch failed	1	workflow-worker	019e2a2e-e3cc-772e-a956-e2ba924719bb	1778824182795	1778824182795	1778824194577	api	019e2a2f-2a11-75e4-a7a6-b151b45ef122
\.


--
-- Data for Name: event_traces; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.event_traces (id, workspace_id, trace_id, event_id, event_type, source, payload, created_at) FROM stdin;
\.


--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.events (id, type, workspace_id, payload, trace_id, correlation_id, causation_id, source, version, created_at) FROM stdin;
019e2a13-9e1f-7764-90a0-a14ea195c22d	workflow.run.completed	default	{"status": "completed", "durationMs": 4821, "workflowId": "019e2a13-9ddf-73e1-ac5c-66108b66008e"}	019e2a13-9e1f-7764-90a0-a4e3f3ead614	019e2a13-9e1f-7764-90a0-ab829c066819	\N	workflow-engine	1	1778813749214
019e2a13-9e1f-7764-90a0-af6af21bd7e5	briefing.generated	default	{"itemCount": 12, "briefingId": "019e2a13-9ddf-73e1-ac5c-7beb421c1224", "generatedMs": 3200}	019e2a13-9e1f-7764-90a0-b02711cae3e8	019e2a13-9e1f-7764-90a0-b7534989ffad	\N	briefing-service	1	1778805109214
019e2a13-9e1f-7764-90a0-b96ec1f27b64	opportunity.identified	default	{"type": "strategic", "score": 0.84, "title": "Mid-market expansion"}	019e2a13-9e1f-7764-90a0-bdba1b6f27e1	019e2a13-9e1f-7764-90a0-c3a343078cad	\N	opportunity-scanner	1	1778779189214
019e2a13-9e1f-7764-90a0-c7909e19cd22	risk.detected	default	{"title": "Churn acceleration risk", "severity": "high", "riskScore": 0.72}	019e2a13-9e1f-7764-90a0-cb8df075ce80	019e2a13-9e1f-7764-90a0-cd2cc136e0ea	\N	risk-monitor	1	1778753269214
019e2a13-9e1f-7764-90a0-d2b575721f63	agent.heartbeat	default	{"status": "running", "agentId": "019e2a13-9ddf-73e1-ac5c-7613cb63fd74", "activeJobs": 2}	019e2a13-9e1f-7764-90a0-d5fe74052ebf	019e2a13-9e1f-7764-90a0-db2b2ea56c46	\N	agent-operator	1	1778735989214
019e2a13-9e1f-7764-90a0-dfdc49d44f8e	workflow.run.completed	default	{"status": "completed", "durationMs": 9134, "workflowId": "019e2a13-9ddf-73e1-ac5c-6957b2448768"}	019e2a13-9e1f-7764-90a0-e1b4154f4171	019e2a13-9e1f-7764-90a0-e5a84b2f38ea	\N	workflow-engine	1	1778727349214
019e2a13-9e1f-7764-90a0-ea4cb77c3f9e	goal.progress.updated	default	{"delta": 0.06, "goalId": "goal-mrr-250k", "progress": 0.74}	019e2a13-9e1f-7764-90a0-eff38dcbb2f3	019e2a13-9e1f-7764-90a0-f2a3b43a410c	\N	goal-tracker	1	1778692789214
019e2a13-9e1f-7764-90a0-fb04d899f0d3	insight.created	default	{"category": "revenue", "insightId": "019e2a13-9e1f-7764-90a0-f4c9125c1573", "confidence": 0.88}	019e2a13-9e1f-7764-90a0-ff0f7b3d41a0	019e2a13-9e1f-7764-90a1-033b092c604c	\N	ai-analyst	1	1778649589214
019e2a13-9e1f-7764-90a1-094b4cdc23bf	approval.requested	default	{"risk": "medium", "runId": "019e2a13-9e1f-7764-90a1-057a238487bf", "operationLabel": "Send pricing email to enterprise list"}	019e2a13-9e1f-7764-90a1-0d19169cbeee	019e2a13-9e1f-7764-90a1-12c853c15e90	\N	approval-service	1	1778632309214
019e2a13-9e1f-7764-90a1-1be590f92390	approval.resolved	default	{"status": "approved", "approvalId": "019e2a13-9e1f-7764-90a1-1424065f7e24", "resolvedBy": "user_acme_owner"}	019e2a13-9e1f-7764-90a1-1dd173ac22cb	019e2a13-9e1f-7764-90a1-21085681debf	\N	approval-service	1	1778623669214
019e2a13-9e1f-7764-90a1-28e8db261ace	risk.escalated	default	{"title": "Key account renewal at risk", "riskId": "019e2a13-9e1f-7764-90a1-25b3f96ce09f", "severity": "critical"}	019e2a13-9e1f-7764-90a1-2feaea7ca605	019e2a13-9e1f-7764-90a1-30b1f841431a	\N	risk-monitor	1	1778563189214
019e2a13-9e1f-7764-90a1-36c9087c4e43	workflow.run.failed	default	{"error": "Rate limit exceeded on AI provider", "attempt": 2, "workflowId": "019e2a13-9ddf-73e1-ac5c-6c67864f856f"}	019e2a13-9e1f-7764-90a1-3b4dfff2184e	019e2a13-9e1f-7764-90a1-3cf9fd2670f8	\N	workflow-engine	1	1778519989214
019e2a13-9e1f-7764-90a1-41b654757fc8	briefing.generated	default	{"itemCount": 9, "briefingId": "019e2a13-9ddf-73e1-ac5c-7f24d7d80b8c", "generatedMs": 2780}	019e2a13-9e1f-7764-90a1-455093cb04e6	019e2a13-9e1f-7764-90a1-4b8f59544eb5	\N	briefing-service	1	1778476789214
019e2a13-9e1f-7764-90a1-50781727ff47	opportunity.status.changed	default	{"to": "evaluating", "from": "identified", "opportunityId": "019e2a13-9e1f-7764-90a1-4f65935cd3fa"}	019e2a13-9e1f-7764-90a1-55b9507a5f2c	019e2a13-9e20-747d-8e51-74c5aec3cea4	\N	ops-api	1	1778433589214
019e2a13-9e20-747d-8e51-7ab2fe10ef00	memory.created	default	{"tags": ["sales", "outbound"], "memoryType": "lesson"}	019e2a13-9e20-747d-8e51-7cc1f274c363	019e2a13-9e20-747d-8e51-81952ca0dfcf	\N	memory-service	1	1778390389214
019e2a13-9e20-747d-8e51-86707007559e	agent.status.changed	default	{"to": "idle", "from": "running", "agentId": "019e2a13-9ddf-73e1-ac5c-739f2bfaca51"}	019e2a13-9e20-747d-8e51-890d75d0b2cc	019e2a13-9e20-747d-8e51-8e5fc753df4e	\N	agent-controller	1	1778303989214
019e2a13-9e20-747d-8e51-90b0d46584a9	workflow.run.completed	default	{"status": "completed", "durationMs": 5102, "workflowId": "019e2a13-9ddf-73e1-ac5c-66108b66008e"}	019e2a13-9e20-747d-8e51-957c05c469c7	019e2a13-9e20-747d-8e51-9bc6468b6381	\N	workflow-engine	1	1778217589214
019e2a13-9e20-747d-8e51-9d44b3c6f9ec	ai.usage.logged	default	{"model": "claude-3-5-sonnet-20241022", "tokens": 12400, "costUsd": 0.037, "provider": "anthropic"}	019e2a13-9e20-747d-8e51-a3506d1cf5a8	019e2a13-9e20-747d-8e51-a7623f8db663	\N	ai-usage-tracker	1	1778131189214
019e2a13-9e20-747d-8e51-a819913b0726	notification.sent	default	{"type": "error", "title": "New critical risk detected", "channel": "slack"}	019e2a13-9e20-747d-8e51-af60d6123116	019e2a13-9e20-747d-8e51-b04b211e1a80	\N	notification-service	1	1778044789214
019e2a13-9e20-747d-8e51-b51e6c17bb80	goal.completed	default	{"title": "Q1 NPS target ≥70", "progress": 1, "completedAt": 1777958389214}	019e2a13-9e20-747d-8e51-ba28f3de3f90	019e2a13-9e20-747d-8e51-bc3ff770cbd8	\N	goal-tracker	1	1777958389214
019e2a1f-2e08-774f-87e9-a1ed40c08cfa	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a18-c402-7338-bdab-25577b1d9897/run", "method": "POST", "requestId": "req-8", "durationMs": 81, "statusCode": 202}	019e2a1f-2e08-774f-87e9-a6b6abd83ce5	req-8	\N	audit-plugin	1	1778823147016
019e2a1f-da72-774f-b154-fd10d08891ec	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a18-c438-732b-88c0-38e5736ffc82/run", "method": "POST", "requestId": "req-e", "durationMs": 12, "statusCode": 202}	019e2a1f-da72-774f-b155-01e0e057f00b	req-e	\N	audit-plugin	1	1778823191154
019e2a27-ab57-7349-8f62-f70b926a58ac	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1b", "durationMs": 8, "statusCode": 201}	019e2a27-ab57-7349-8f62-fa5e651a9267	req-1b	\N	audit-plugin	1	1778823703383
019e2a18-c40a-7187-910b-800f6c492dc3	audit.api.mutation	default	{"url": "/api/v1/workflows/", "method": "POST", "requestId": "req-6", "durationMs": 18, "statusCode": 201}	019e2a18-c40a-7187-910b-85328b249f56	req-6	\N	audit-plugin	1	1778822726666
019e2a18-c426-74e9-9f89-50214e8d75e4	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a18-c402-7338-bdab-25577b1d9897/run", "method": "POST", "requestId": "req-7", "durationMs": 15, "statusCode": 202}	019e2a18-c426-74e9-9f89-57628993f8e5	req-7	\N	audit-plugin	1	1778822726694
019e2a18-c43c-765b-9d5a-4de3dd5b19dd	audit.api.mutation	default	{"url": "/api/v1/workflows/", "method": "POST", "requestId": "req-8", "durationMs": 18, "statusCode": 201}	019e2a18-c43c-765b-9d5a-52753fb05f38	req-8	\N	audit-plugin	1	1778822726716
019e2a1f-2e0a-7384-993a-50166ea03b00	queue.job.started	default	{"jobId": "019e2a1f-2dd0-7016-b332-35d7f32f18df", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-7904", "queueName": "workflow", "timestamp": 1778823147018, "workspaceId": "default"}	019e2a1f-2e0a-7384-993a-50166ea03b00	019e2a1f-2e0a-7384-993a-50166ea03b00	\N	workflow-worker	1	1778823147018
019e2a1f-2ea2-7496-83e0-7a4e87dd91e7	workflow.run.completed	default	{"runId": "019e2a1f-2dd0-7016-b332-35d7f32f18df", "traceId": "019e2a1f-2dd0-7016-b332-380d9917ae83", "durationMs": 78, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a1f-2ea2-7496-83e0-7a4e87dd91e7	019e2a1f-2ea2-7496-83e0-7a4e87dd91e7	\N	workflow-worker	1	1778823147170
019e2a27-aced-71db-a274-d1618ed45c5e	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1c", "durationMs": 9, "statusCode": 201}	019e2a27-aced-71db-a274-d64c161d6e19	req-1c	\N	audit-plugin	1	1778823703789
019e2a27-ae5d-71ed-b45a-bbd97ba76315	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1d", "durationMs": 8, "statusCode": 201}	019e2a27-ae5d-71ed-b45a-bc3cb3a01db3	req-1d	\N	audit-plugin	1	1778823704157
019e2a27-afbb-756e-ac72-261e6a6a691f	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1e", "durationMs": 9, "statusCode": 201}	019e2a27-afbb-756e-ac72-2967412b78b7	req-1e	\N	audit-plugin	1	1778823704507
019e2a27-b11e-779c-b2b2-28168f56713f	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1f", "durationMs": 8, "statusCode": 201}	019e2a27-b11e-779c-b2b2-2e2ab4c13ea9	req-1f	\N	audit-plugin	1	1778823704862
019e2a27-b284-739a-933a-8d792a68a92a	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1g", "durationMs": 9, "statusCode": 201}	019e2a27-b284-739a-933a-920130b49140	req-1g	\N	audit-plugin	1	1778823705220
019e2a27-b3f3-70fa-94ff-6eb9c293306f	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1h", "durationMs": 9, "statusCode": 201}	019e2a27-b3f3-70fa-94ff-70cde81f9ec2	req-1h	\N	audit-plugin	1	1778823705587
019e2a27-b573-73e4-8747-0ad00d316744	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1i", "durationMs": 9, "statusCode": 201}	019e2a27-b573-73e4-8747-0dd53440580a	req-1i	\N	audit-plugin	1	1778823705971
019e2a27-b6e4-777c-a0c4-4c91ccd03e77	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1j", "durationMs": 9, "statusCode": 201}	019e2a27-b6e4-777c-a0c4-5029a23cdd49	req-1j	\N	audit-plugin	1	1778823706340
019e2a27-b871-701f-bf15-80c3e888c040	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1k", "durationMs": 8, "statusCode": 201}	019e2a27-b871-701f-bf15-85f0fa0ffefa	req-1k	\N	audit-plugin	1	1778823706737
019e2a27-b9e8-7528-a30f-4bb12ce94509	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1l", "durationMs": 8, "statusCode": 201}	019e2a27-b9e8-7528-a30f-4c2a9855e45c	req-1l	\N	audit-plugin	1	1778823707112
019e2a27-bb4c-7651-a171-6bd7b03283e5	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1m", "durationMs": 8, "statusCode": 201}	019e2a27-bb4c-7651-a171-6d22f4ab8586	req-1m	\N	audit-plugin	1	1778823707468
019e2a27-bcb2-7069-be50-ff8172972d16	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1n", "durationMs": 8, "statusCode": 201}	019e2a27-bcb2-7069-be51-03c6ad13e806	req-1n	\N	audit-plugin	1	1778823707826
019e2a27-be18-76a9-b707-fa3b2402de12	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1o", "durationMs": 8, "statusCode": 201}	019e2a27-be18-76a9-b707-fdd25e9935db	req-1o	\N	audit-plugin	1	1778823708184
019e2a27-bf97-72f6-a6ab-489c5cf158fa	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1p", "durationMs": 9, "statusCode": 201}	019e2a27-bf97-72f6-a6ab-4c73ba81e3af	req-1p	\N	audit-plugin	1	1778823708567
019e2a27-c108-722a-bd05-44ab41301586	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1q", "durationMs": 9, "statusCode": 201}	019e2a27-c108-722a-bd05-49e5ff8aa265	req-1q	\N	audit-plugin	1	1778823708936
019e2a27-c27a-726d-a76b-685718c5f8d5	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1r", "durationMs": 9, "statusCode": 201}	019e2a27-c27a-726d-a76b-6f14f18de16f	req-1r	\N	audit-plugin	1	1778823709306
019e2a27-c3ff-730a-90ff-9a15bec94a6f	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1s", "durationMs": 9, "statusCode": 201}	019e2a27-c3ff-730a-90ff-9d63ca8b088a	req-1s	\N	audit-plugin	1	1778823709695
019e2a27-c56f-711c-a978-a3d56016ada0	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1t", "durationMs": 8, "statusCode": 201}	019e2a27-c56f-711c-a978-a52890225efd	req-1t	\N	audit-plugin	1	1778823710063
019e2a27-c6f1-71df-9c5d-c7ca3ec1a04e	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1u", "durationMs": 8, "statusCode": 201}	019e2a27-c6f1-71df-9c5d-cb1c2050c179	req-1u	\N	audit-plugin	1	1778823710449
019e2a27-e702-73d7-8e1f-6c46dc892327	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-ab53-75a0-b3f8-7df80437fe20/run", "method": "POST", "requestId": "req-1v", "durationMs": 16, "statusCode": 202}	019e2a27-e702-73d7-8e1f-7115b9180904	req-1v	\N	audit-plugin	1	1778823718658
019e2a27-e888-715f-a782-f64194b56fba	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-ace7-7569-bce8-75cff7a4406a/run", "method": "POST", "requestId": "req-1w", "durationMs": 12, "statusCode": 202}	019e2a27-e888-715f-a782-fb8a3edc5840	req-1w	\N	audit-plugin	1	1778823719048
019e2a27-ea04-7469-9d7c-ef9c91c9f787	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-ae58-739c-8835-344a06d2d580/run", "method": "POST", "requestId": "req-1x", "durationMs": 12, "statusCode": 202}	019e2a27-ea04-7469-9d7c-f2fd6703d6ab	req-1x	\N	audit-plugin	1	1778823719428
019e2a27-eb74-750c-b2c4-43fc41cacb32	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-afb5-76bc-ae87-988dd0d36522/run", "method": "POST", "requestId": "req-1y", "durationMs": 11, "statusCode": 202}	019e2a27-eb74-750c-b2c4-4406a3fa5883	req-1y	\N	audit-plugin	1	1778823719796
019e2a1f-2e35-723b-b71e-42ec5105cf89	workflow.run.started	default	{"runId": "019e2a1f-2dd0-7016-b332-35d7f32f18df", "traceId": "019e2a1f-2dd0-7016-b332-380d9917ae83"}	019e2a1f-2e35-723b-b71e-42ec5105cf89	019e2a1f-2e35-723b-b71e-42ec5105cf89	\N	workflow-worker	1	1778823147061
019e2a1f-2e7f-745f-aa8a-b5b9d5888c05	workflow.step.completed	default	{"runId": "019e2a1f-2dd0-7016-b332-35d7f32f18df", "stepId": "step1", "traceId": "019e2a1f-2dd0-7016-b332-380d9917ae83"}	019e2a1f-2e7f-745f-aa8a-b5b9d5888c05	019e2a1f-2e7f-745f-aa8a-b5b9d5888c05	\N	workflow-worker	1	1778823147136
019e2a19-888c-74a8-9e9a-6ca66520d472	memory.created	default	{"tags": ["rc1"], "type": "observation", "memoryId": "019e2a19-8885-7688-a4f5-f8c89d09affe", "workspaceId": "default"}	019e2a19-888c-74a8-9e9a-70ab4332cee3	019e2a19-888c-74a8-9e9a-74fa05831bdf	\N	api	1	1778822776972
019e2a1a-443e-70cd-a8b7-8419c4b8b1b7	queue.job.started	default	{"jobId": "019e2a18-c41a-77db-b5b7-7d0605b1d852", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-19616", "queueName": "workflow", "timestamp": 1778822825022, "workspaceId": "default"}	019e2a1a-443e-70cd-a8b7-8419c4b8b1b7	019e2a1a-443e-70cd-a8b7-8419c4b8b1b7	\N	workflow-worker	1	1778822825023
019e2a1a-44f6-71cd-85d3-823c23b548b6	workflow.run.started	default	{"runId": "019e2a18-c41a-77db-b5b7-7d0605b1d852", "traceId": "019e2a18-c41a-77db-b5b7-82582a84d13d"}	019e2a1a-44f6-71cd-85d3-823c23b548b6	019e2a1a-44f6-71cd-85d3-823c23b548b6	\N	workflow-worker	1	1778822825206
019e2a1a-4581-7418-a577-6197ec48490d	workflow.run.failed	default	{"runId": "019e2a18-c41a-77db-b5b7-7d0605b1d852", "reason": "there is no unique or exclusion constraint matching the ON CONFLICT specification", "traceId": "019e2a18-c41a-77db-b5b7-82582a84d13d"}	019e2a1a-4581-7418-a577-6197ec48490d	019e2a1a-4581-7418-a577-6197ec48490d	\N	workflow-worker	1	1778822825345
019e2a1a-45c6-73c4-b837-3b55636dc7b4	observability.failure.linked	default	{"runId": "019e2a18-c41a-77db-b5b7-7d0605b1d852", "failureId": "019e2a1a-45aa-7197-bd3e-a1a1cac4ca4a", "rootCause": "there is no unique or exclusion constraint matching the ON CONFLICT specification", "timestamp": 1778822825386, "linkedEventIds": ["019e2a1a-45aa-7197-bd3e-9e7c6a4941cf"]}	019e2a18-c41a-77db-b5b7-82582a84d13d	019e2a18-c41a-77db-b5b7-82582a84d13d	\N	observability-service	1	1778822825414
019e2a1f-2ed3-731d-a93b-9def21b70320	queue.job.completed	default	{"jobId": "019e2a1f-2dd0-7016-b332-35d7f32f18df", "jobName": "execute-workflow", "workerId": "workflow-worker-7904", "queueName": "workflow", "timestamp": 1778823147219, "durationMs": 250, "workspaceId": "default"}	019e2a1f-2ed3-731d-a93b-9def21b70320	019e2a1f-2ed3-731d-a93b-9def21b70320	\N	workflow-worker	1	1778823147219
019e2a27-e703-7789-8582-2fa5ab9be341	queue.job.started	default	{"jobId": "019e2a27-e6f5-70fd-a796-5b4e43099e1a", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823718659, "workspaceId": "default"}	019e2a27-e703-7789-8582-2fa5ab9be341	019e2a27-e703-7789-8582-2fa5ab9be341	\N	workflow-worker	1	1778823718660
019e2a1a-4601-7661-9518-96147b0d0241	queue.job.retry_scheduled	default	{"jobId": "1", "attempt": 2, "delayMs": 4000, "jobName": "embed-memory", "workerId": "memory-worker-10276", "queueName": "memory", "timestamp": 1778822825473, "workspaceId": "default"}	019e2a1a-4602-7661-9518-9c934816c824	019e2a1a-4602-7661-9518-a373bb05b072	\N	memory-worker	1	1778822825474
019e2a1a-4560-7661-9518-610f24604a01	queue.job.started	default	{"jobId": "1", "attempt": 1, "jobName": "embed-memory", "workerId": "memory-worker-10276", "queueName": "memory", "timestamp": 1778822825312, "workspaceId": "default"}	019e2a1a-4560-7661-9518-6f07166d768b	019e2a1a-4560-7661-9518-73eb87a26fc3	\N	memory-worker	1	1778822825312
019e2a1a-4600-7661-9518-781db3d5b73c	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "1", "jobName": "embed-memory", "attempts": 1, "workerId": "memory-worker-10276", "exhausted": false, "queueName": "memory", "timestamp": 1778822825472, "workspaceId": "default"}	019e2a1a-4600-7661-9518-82713213cfb0	019e2a1a-4600-7661-9518-8876596ebac5	\N	memory-worker	1	1778822825472
019e2a1a-4650-7458-889a-334b5511ea1a	queue.job.completed	default	{"jobId": "019e2a18-c41a-77db-b5b7-7d0605b1d852", "jobName": "execute-workflow", "workerId": "workflow-worker-19616", "queueName": "workflow", "timestamp": 1778822825552, "durationMs": 98862, "workspaceId": "default"}	019e2a1a-4650-7458-889a-334b5511ea1a	019e2a1a-4650-7458-889a-334b5511ea1a	\N	workflow-worker	1	1778822825552
019e2a1a-4e1b-7661-9518-ad72ffc5dced	queue.job.started	default	{"jobId": "1", "attempt": 2, "jobName": "embed-memory", "workerId": "memory-worker-10276", "queueName": "memory", "timestamp": 1778822827547, "workspaceId": "default"}	019e2a1a-4e1b-7661-9518-b16376776650	019e2a1a-4e1b-7661-9518-bdefc74793fb	\N	memory-worker	1	1778822827547
019e2a1a-4e24-7661-9518-de477db62808	queue.job.retry_scheduled	default	{"jobId": "1", "attempt": 3, "delayMs": 8000, "jobName": "embed-memory", "workerId": "memory-worker-10276", "queueName": "memory", "timestamp": 1778822827556, "workspaceId": "default"}	019e2a1a-4e24-7661-9518-e4ceac0bd112	019e2a1a-4e24-7661-9518-ec233a3213d1	\N	memory-worker	1	1778822827556
019e2a1a-4e23-7661-9518-c7b506e74e6b	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "1", "jobName": "embed-memory", "attempts": 2, "workerId": "memory-worker-10276", "exhausted": false, "queueName": "memory", "timestamp": 1778822827555, "workspaceId": "default"}	019e2a1a-4e24-7661-9518-cf1e00ce4318	019e2a1a-4e24-7661-9518-d6cd0af7c71f	\N	memory-worker	1	1778822827556
019e2a1a-5dd5-7661-9518-f2ec044aa7fa	queue.job.started	default	{"jobId": "1", "attempt": 3, "jobName": "embed-memory", "workerId": "memory-worker-10276", "queueName": "memory", "timestamp": 1778822831573, "workspaceId": "default"}	019e2a1a-5dd5-7661-9518-fe79ad42dfd0	019e2a1a-5dd5-7661-9519-040d3823d9a4	\N	memory-worker	1	1778822831573
019e2a1a-5e06-7661-9519-0954126051b7	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "1", "jobName": "embed-memory", "attempts": 3, "workerId": "memory-worker-10276", "exhausted": true, "queueName": "memory", "timestamp": 1778822831622, "workspaceId": "default"}	019e2a1a-5e06-7661-9519-13bd3cbaecd1	019e2a1a-5e06-7661-9519-19ed13dd4293	\N	memory-worker	1	1778822831622
019e2a27-e7ad-7309-b5e2-88192541f6a3	workflow.run.completed	default	{"runId": "019e2a27-e6f5-70fd-a796-5b4e43099e1a", "traceId": "019e2a27-e6f5-70fd-a796-5fe06ab1981c", "durationMs": 89, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a27-e7ad-7309-b5e2-88192541f6a3	019e2a27-e7ad-7309-b5e2-88192541f6a3	\N	workflow-worker	1	1778823718829
019e2a1f-2e9a-7139-8bd1-78c766958338	recovery.checkpoint.created	default	{"runId": "019e2a1f-2dd0-7016-b332-35d7f32f18df", "stepId": "step1", "timestamp": 1778823147145, "workspaceId": "default", "checkpointId": "019e2a1f-2e89-71ed-a558-506384b5e749"}	019e2a1f-2dd0-7016-b332-380d9917ae83	019e2a1f-2dd0-7016-b332-380d9917ae83	\N	recovery-service	1	1778823147162
019e2a27-e72e-767e-97bd-b957a912e7ef	workflow.run.started	default	{"runId": "019e2a27-e6f5-70fd-a796-5b4e43099e1a", "traceId": "019e2a27-e6f5-70fd-a796-5fe06ab1981c"}	019e2a27-e72e-767e-97bd-b957a912e7ef	019e2a27-e72e-767e-97bd-b957a912e7ef	\N	workflow-worker	1	1778823718702
019e2a27-e786-76bb-8e04-abb976a30790	workflow.step.completed	default	{"runId": "019e2a27-e6f5-70fd-a796-5b4e43099e1a", "stepId": "s1", "traceId": "019e2a27-e6f5-70fd-a796-5fe06ab1981c"}	019e2a27-e786-76bb-8e04-abb976a30790	019e2a27-e786-76bb-8e04-abb976a30790	\N	workflow-worker	1	1778823718790
019e2a27-e7e0-7439-ad34-9855dc721194	queue.job.completed	default	{"jobId": "019e2a27-e6f5-70fd-a796-5b4e43099e1a", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823718880, "durationMs": 228, "workspaceId": "default"}	019e2a27-e7e0-7439-ad34-9855dc721194	019e2a27-e7e0-7439-ad34-9855dc721194	\N	workflow-worker	1	1778823718880
019e2a27-e891-715b-83b1-0061b1fefc01	workflow.run.started	default	{"runId": "019e2a27-e87f-7203-9c33-a97d8d196838", "traceId": "019e2a27-e87f-7203-9c33-ad596cbab721"}	019e2a27-e891-715b-83b1-0061b1fefc01	019e2a27-e891-715b-83b1-0061b1fefc01	\N	workflow-worker	1	1778823719057
019e2a27-e8c0-7759-99e1-a5367c1b287a	workflow.step.completed	default	{"runId": "019e2a27-e87f-7203-9c33-a97d8d196838", "stepId": "s1", "traceId": "019e2a27-e87f-7203-9c33-ad596cbab721"}	019e2a27-e8c0-7759-99e1-a5367c1b287a	019e2a27-e8c0-7759-99e1-a5367c1b287a	\N	workflow-worker	1	1778823719104
019e2a27-e8e7-701f-88f3-c07cf4406b10	queue.job.completed	default	{"jobId": "019e2a27-e87f-7203-9c33-a97d8d196838", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823719143, "durationMs": 97, "workspaceId": "default"}	019e2a27-e8e7-701f-88f3-c07cf4406b10	019e2a27-e8e7-701f-88f3-c07cf4406b10	\N	workflow-worker	1	1778823719143
019e2a27-ea12-73a9-a94c-66faade59d76	workflow.run.started	default	{"runId": "019e2a27-e9fb-75ff-8604-662549188e42", "traceId": "019e2a27-e9fb-75ff-8604-6a20f882bd59"}	019e2a27-ea12-73a9-a94c-66faade59d76	019e2a27-ea12-73a9-a94c-66faade59d76	\N	workflow-worker	1	1778823719442
019e2a27-ea47-762b-88ee-8a4f196ab047	workflow.step.completed	default	{"runId": "019e2a27-e9fb-75ff-8604-662549188e42", "stepId": "s1", "traceId": "019e2a27-e9fb-75ff-8604-6a20f882bd59"}	019e2a27-ea47-762b-88ee-8a4f196ab047	019e2a27-ea47-762b-88ee-8a4f196ab047	\N	workflow-worker	1	1778823719495
019e2a27-ea66-722a-9dcf-1a66cb224e69	queue.job.completed	default	{"jobId": "019e2a27-e9fb-75ff-8604-662549188e42", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823719526, "durationMs": 100, "workspaceId": "default"}	019e2a27-ea66-722a-9dcf-1a66cb224e69	019e2a27-ea66-722a-9dcf-1a66cb224e69	\N	workflow-worker	1	1778823719526
019e2a27-eb7e-70da-abc2-c29c92bdbfa0	workflow.run.started	default	{"runId": "019e2a27-eb6c-7798-9e77-b3cd111301dc", "traceId": "019e2a27-eb6c-7798-9e77-b58d28604493"}	019e2a27-eb7e-70da-abc2-c29c92bdbfa0	019e2a27-eb7e-70da-abc2-c29c92bdbfa0	\N	workflow-worker	1	1778823719806
019e2a27-ebaa-757c-9d9c-c651f6a1023f	workflow.step.completed	default	{"runId": "019e2a27-eb6c-7798-9e77-b3cd111301dc", "stepId": "s1", "traceId": "019e2a27-eb6c-7798-9e77-b58d28604493"}	019e2a27-ebaa-757c-9d9c-c651f6a1023f	019e2a27-ebaa-757c-9d9c-c651f6a1023f	\N	workflow-worker	1	1778823719850
019e2a27-ebd1-7716-9791-d2cfca9525b6	queue.job.completed	default	{"jobId": "019e2a27-eb6c-7798-9e77-b3cd111301dc", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823719889, "durationMs": 94, "workspaceId": "default"}	019e2a27-ebd1-7716-9791-d2cfca9525b6	019e2a27-ebd1-7716-9791-d2cfca9525b6	\N	workflow-worker	1	1778823719890
019e2a27-ed27-74f9-91cf-22eace0e7907	workflow.run.completed	default	{"runId": "019e2a27-ecd1-734c-baed-bf50bb7a3ebe", "traceId": "019e2a27-ecd1-734c-baed-c05113a4cb53", "durationMs": 55, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a27-ed27-74f9-91cf-22eace0e7907	019e2a27-ed27-74f9-91cf-22eace0e7907	\N	workflow-worker	1	1778823720231
019e2a27-ee60-710f-be8e-d365b8326884	queue.job.started	default	{"jobId": "019e2a27-ee55-716e-b73e-47dff9244354", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823720544, "workspaceId": "default"}	019e2a27-ee60-710f-be8e-d365b8326884	019e2a27-ee60-710f-be8e-d365b8326884	\N	workflow-worker	1	1778823720544
019e2a27-eea2-715e-b589-f9674049f29d	workflow.run.completed	default	{"runId": "019e2a27-ee55-716e-b73e-47dff9244354", "traceId": "019e2a27-ee55-716e-b73e-489cdb9554a8", "durationMs": 48, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a27-eea2-715e-b589-f9674049f29d	019e2a27-eea2-715e-b589-f9674049f29d	\N	workflow-worker	1	1778823720610
019e2a27-efe2-745d-bee8-dcd78806f433	queue.job.started	default	{"jobId": "019e2a27-efd8-77bb-8d9b-728ff860c105", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823720930, "workspaceId": "default"}	019e2a27-efe2-745d-bee8-dcd78806f433	019e2a27-efe2-745d-bee8-dcd78806f433	\N	workflow-worker	1	1778823720930
019e2a27-f02a-7734-9d44-809853923a53	workflow.run.completed	default	{"runId": "019e2a27-efd8-77bb-8d9b-728ff860c105", "traceId": "019e2a27-efd8-77bb-8d9b-7562dd76c055", "durationMs": 50, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a27-f02a-7734-9d44-809853923a53	019e2a27-f02a-7734-9d44-809853923a53	\N	workflow-worker	1	1778823721002
019e2a27-f13c-727b-9007-31e31371169c	queue.job.started	default	{"jobId": "019e2a27-f135-763e-89f1-9cfbf82a21c9", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823721276, "workspaceId": "default"}	019e2a27-f13c-727b-9007-31e31371169c	019e2a27-f13c-727b-9007-31e31371169c	\N	workflow-worker	1	1778823721276
019e2a27-f197-75fc-b4bd-023761fe2731	workflow.run.completed	default	{"runId": "019e2a27-f135-763e-89f1-9cfbf82a21c9", "traceId": "019e2a27-f135-763e-89f1-a3a33a781ce2", "durationMs": 71, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a27-f197-75fc-b4bd-023761fe2731	019e2a27-f197-75fc-b4bd-023761fe2731	\N	workflow-worker	1	1778823721367
019e2a28-6a2a-72b8-b8b2-18be5d3d9bff	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-bcad-772b-b156-20bb6d6a0328/run", "method": "POST", "requestId": "req-2h", "durationMs": 9, "statusCode": 202}	019e2a28-6a2a-72b8-b8b2-1f3ec01fa74b	req-2h	\N	audit-plugin	1	1778823752234
019e2a1f-da73-75bb-ab28-ddf6b3d2c150	queue.job.started	default	{"jobId": "019e2a1f-da6a-7695-8f18-5986320d4ebc", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-7904", "queueName": "workflow", "timestamp": 1778823191155, "workspaceId": "default"}	019e2a1f-da73-75bb-ab28-ddf6b3d2c150	019e2a1f-da73-75bb-ab28-ddf6b3d2c150	\N	workflow-worker	1	1778823191155
019e2a1f-db02-717a-ae44-b55761c215e5	workflow.run.completed	default	{"runId": "019e2a1f-da6a-7695-8f18-5986320d4ebc", "traceId": "019e2a1f-da6a-7695-8f18-5d600625aa81", "durationMs": 64, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a1f-db02-717a-ae44-b55761c215e5	019e2a1f-db02-717a-ae44-b55761c215e5	\N	workflow-worker	1	1778823191298
019e2a27-e7a2-76dd-b28b-4f1422b2f47f	recovery.checkpoint.created	default	{"runId": "019e2a27-e6f5-70fd-a796-5b4e43099e1a", "stepId": "s1", "timestamp": 1778823718798, "workspaceId": "default", "checkpointId": "019e2a27-e78e-73da-b893-ecf59291a1a1"}	019e2a27-e6f5-70fd-a796-5fe06ab1981c	019e2a27-e6f5-70fd-a796-5fe06ab1981c	\N	recovery-service	1	1778823718818
019e2a27-e8d2-73ac-b7db-c2c3ff8f5ccc	recovery.checkpoint.created	default	{"runId": "019e2a27-e87f-7203-9c33-a97d8d196838", "stepId": "s1", "timestamp": 1778823719118, "workspaceId": "default", "checkpointId": "019e2a27-e8ce-738b-8f15-ca35bdf04cac"}	019e2a27-e87f-7203-9c33-ad596cbab721	019e2a27-e87f-7203-9c33-ad596cbab721	\N	recovery-service	1	1778823719122
019e2a27-ea52-75e2-96d6-90b417bf70b9	recovery.checkpoint.created	default	{"runId": "019e2a27-e9fb-75ff-8604-662549188e42", "stepId": "s1", "timestamp": 1778823719503, "workspaceId": "default", "checkpointId": "019e2a27-ea4f-72f3-98b9-38a92877ffa0"}	019e2a27-e9fb-75ff-8604-6a20f882bd59	019e2a27-e9fb-75ff-8604-6a20f882bd59	\N	recovery-service	1	1778823719506
019e2a27-ebb8-71c6-b244-e1202d284762	recovery.checkpoint.created	default	{"runId": "019e2a27-eb6c-7798-9e77-b3cd111301dc", "stepId": "s1", "timestamp": 1778823719859, "workspaceId": "default", "checkpointId": "019e2a27-ebb3-719a-b25e-e4fbdbe1d7a1"}	019e2a27-eb6c-7798-9e77-b58d28604493	019e2a27-eb6c-7798-9e77-b58d28604493	\N	recovery-service	1	1778823719864
019e2a27-ed1c-739b-bc54-4723f9b1afa8	recovery.checkpoint.created	default	{"runId": "019e2a27-ecd1-734c-baed-bf50bb7a3ebe", "stepId": "s1", "timestamp": 1778823720216, "workspaceId": "default", "checkpointId": "019e2a27-ed18-772a-aa21-9ce79f52ffb6"}	019e2a27-ecd1-734c-baed-c05113a4cb53	019e2a27-ecd1-734c-baed-c05113a4cb53	\N	recovery-service	1	1778823720220
019e2a27-ee9b-7698-91c6-87e6cc5e8801	recovery.checkpoint.created	default	{"runId": "019e2a27-ee55-716e-b73e-47dff9244354", "stepId": "s1", "timestamp": 1778823720600, "workspaceId": "default", "checkpointId": "019e2a27-ee98-77d9-992d-90a6f7be35a1"}	019e2a27-ee55-716e-b73e-489cdb9554a8	019e2a27-ee55-716e-b73e-489cdb9554a8	\N	recovery-service	1	1778823720603
019e2a27-f01e-709d-9f45-e5c3088df709	recovery.checkpoint.created	default	{"runId": "019e2a27-efd8-77bb-8d9b-728ff860c105", "stepId": "s1", "timestamp": 1778823720986, "workspaceId": "default", "checkpointId": "019e2a27-f01a-710d-9530-dbcca8f7c43a"}	019e2a27-efd8-77bb-8d9b-7562dd76c055	019e2a27-efd8-77bb-8d9b-7562dd76c055	\N	recovery-service	1	1778823720990
019e2a27-f18e-7759-a4ae-5836cf2ae61d	recovery.checkpoint.created	default	{"runId": "019e2a27-f135-763e-89f1-9cfbf82a21c9", "stepId": "s1", "timestamp": 1778823721355, "workspaceId": "default", "checkpointId": "019e2a27-f18b-7008-bf64-ba91a0cb45a3"}	019e2a27-f135-763e-89f1-a3a33a781ce2	019e2a27-f135-763e-89f1-a3a33a781ce2	\N	recovery-service	1	1778823721358
019e2a27-f2bd-75c3-b2a3-bc9263be870e	queue.job.started	default	{"jobId": "019e2a27-f2b4-75ff-89f8-4c68f77711fe", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823721661, "workspaceId": "default"}	019e2a27-f2bd-75c3-b2a3-bc9263be870e	019e2a27-f2bd-75c3-b2a3-bc9263be870e	\N	workflow-worker	1	1778823721661
019e2a27-f2c4-745f-8d27-123316c012a9	workflow.run.started	default	{"runId": "019e2a27-f2b4-75ff-89f8-4c68f77711fe", "traceId": "019e2a27-f2b4-75ff-89f8-501eba7413bd"}	019e2a27-f2c4-745f-8d27-123316c012a9	019e2a27-f2c4-745f-8d27-123316c012a9	\N	workflow-worker	1	1778823721668
019e2a27-f2fc-728d-bcfb-2e2940ab287b	workflow.step.completed	default	{"runId": "019e2a27-f2b4-75ff-89f8-4c68f77711fe", "stepId": "s1", "traceId": "019e2a27-f2b4-75ff-89f8-501eba7413bd"}	019e2a27-f2fc-728d-bcfb-2e2940ab287b	019e2a27-f2fc-728d-bcfb-2e2940ab287b	\N	workflow-worker	1	1778823721725
019e2a27-f309-7198-915f-08980b196192	recovery.checkpoint.created	default	{"runId": "019e2a27-f2b4-75ff-89f8-4c68f77711fe", "stepId": "s1", "timestamp": 1778823721733, "workspaceId": "default", "checkpointId": "019e2a27-f305-754e-a1d2-2e7e343c85ba"}	019e2a27-f2b4-75ff-89f8-501eba7413bd	019e2a27-f2b4-75ff-89f8-501eba7413bd	\N	recovery-service	1	1778823721737
019e2a27-f31e-768e-b258-e12de6d8c926	queue.job.completed	default	{"jobId": "019e2a27-f2b4-75ff-89f8-4c68f77711fe", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823721758, "durationMs": 100, "workspaceId": "default"}	019e2a27-f31e-768e-b258-e12de6d8c926	019e2a27-f31e-768e-b258-e12de6d8c926	\N	workflow-worker	1	1778823721758
019e2a27-f473-7746-a18e-1c5bf177188b	recovery.checkpoint.created	default	{"runId": "019e2a27-f420-7482-a357-cc9aca9a86a0", "stepId": "s1", "timestamp": 1778823722094, "workspaceId": "default", "checkpointId": "019e2a27-f46e-709e-bb36-b66a20b7ed53"}	019e2a27-f420-7482-a357-d307e0be459a	019e2a27-f420-7482-a357-d307e0be459a	\N	recovery-service	1	1778823722100
019e2a27-f482-753f-84b6-a0d8dc96850b	workflow.run.completed	default	{"runId": "019e2a27-f420-7482-a357-cc9aca9a86a0", "traceId": "019e2a27-f420-7482-a357-d307e0be459a", "durationMs": 66, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a27-f482-753f-84b6-a0d8dc96850b	019e2a27-f482-753f-84b6-a0d8dc96850b	\N	workflow-worker	1	1778823722114
019e2a28-6733-705b-9d2f-9689da03cc50	queue.job.started	default	{"jobId": "019e2a28-6728-71b9-aa98-5541ae7d8827", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823751475, "workspaceId": "default"}	019e2a28-6733-705b-9d2f-9689da03cc50	019e2a28-6733-705b-9d2f-9689da03cc50	\N	workflow-worker	1	1778823751475
019e2a28-673d-71cc-83d2-0e2e45a2ba63	workflow.run.started	default	{"runId": "019e2a28-6728-71b9-aa98-5541ae7d8827", "traceId": "019e2a28-6728-71b9-aa98-5a880110fecb"}	019e2a28-673d-71cc-83d2-0e2e45a2ba63	019e2a28-673d-71cc-83d2-0e2e45a2ba63	\N	workflow-worker	1	1778823751485
019e2a28-6778-719a-9e18-a350b7e05cd0	workflow.step.completed	default	{"runId": "019e2a28-6728-71b9-aa98-5541ae7d8827", "stepId": "s1", "traceId": "019e2a28-6728-71b9-aa98-5a880110fecb"}	019e2a28-6778-719a-9e18-a350b7e05cd0	019e2a28-6778-719a-9e18-a350b7e05cd0	\N	workflow-worker	1	1778823751544
019e2a1f-da89-70fa-86ca-c3b761660964	workflow.run.started	default	{"runId": "019e2a1f-da6a-7695-8f18-5986320d4ebc", "traceId": "019e2a1f-da6a-7695-8f18-5d600625aa81"}	019e2a1f-da89-70fa-86ca-c3b761660964	019e2a1f-da89-70fa-86ca-c3b761660964	\N	workflow-worker	1	1778823191177
019e2a1f-dadf-725c-a29e-3381e98e01db	workflow.step.completed	default	{"runId": "019e2a1f-da6a-7695-8f18-5986320d4ebc", "stepId": "step1", "traceId": "019e2a1f-da6a-7695-8f18-5d600625aa81"}	019e2a1f-dadf-725c-a29e-3381e98e01db	019e2a1f-dadf-725c-a29e-3381e98e01db	\N	workflow-worker	1	1778823191263
019e2a1f-db09-7489-899f-46c0d90a98a0	queue.job.completed	default	{"jobId": "019e2a1f-da6a-7695-8f18-5986320d4ebc", "jobName": "execute-workflow", "workerId": "workflow-worker-7904", "queueName": "workflow", "timestamp": 1778823191305, "durationMs": 153, "workspaceId": "default"}	019e2a1f-db09-7489-899f-46c0d90a98a0	019e2a1f-db09-7489-899f-46c0d90a98a0	\N	workflow-worker	1	1778823191305
019e2a27-e889-74ae-b70c-7d33f0d6e6c0	queue.job.started	default	{"jobId": "019e2a27-e87f-7203-9c33-a97d8d196838", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823719049, "workspaceId": "default"}	019e2a27-e889-74ae-b70c-7d33f0d6e6c0	019e2a27-e889-74ae-b70c-7d33f0d6e6c0	\N	workflow-worker	1	1778823719049
019e2a27-e8dd-70ab-b54e-7e65ce3c809a	workflow.run.completed	default	{"runId": "019e2a27-e87f-7203-9c33-a97d8d196838", "traceId": "019e2a27-e87f-7203-9c33-ad596cbab721", "durationMs": 61, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a27-e8dd-70ab-b54e-7e65ce3c809a	019e2a27-e8dd-70ab-b54e-7e65ce3c809a	\N	workflow-worker	1	1778823719133
019e2a27-ea06-71cb-8b24-0b04e7a7d058	queue.job.started	default	{"jobId": "019e2a27-e9fb-75ff-8604-662549188e42", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823719430, "workspaceId": "default"}	019e2a27-ea06-71cb-8b24-0b04e7a7d058	019e2a27-ea06-71cb-8b24-0b04e7a7d058	\N	workflow-worker	1	1778823719430
019e2a27-ea5a-7152-9185-7e8158833873	workflow.run.completed	default	{"runId": "019e2a27-e9fb-75ff-8604-662549188e42", "traceId": "019e2a27-e9fb-75ff-8604-6a20f882bd59", "durationMs": 58, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a27-ea5a-7152-9185-7e8158833873	019e2a27-ea5a-7152-9185-7e8158833873	\N	workflow-worker	1	1778823719514
019e2a27-eb76-77ee-8250-5b658e569634	queue.job.started	default	{"jobId": "019e2a27-eb6c-7798-9e77-b3cd111301dc", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823719798, "workspaceId": "default"}	019e2a27-eb76-77ee-8250-5b658e569634	019e2a27-eb76-77ee-8250-5b658e569634	\N	workflow-worker	1	1778823719798
019e2a27-ebc8-74ce-b84d-6f77805c3db1	workflow.run.completed	default	{"runId": "019e2a27-eb6c-7798-9e77-b3cd111301dc", "traceId": "019e2a27-eb6c-7798-9e77-b58d28604493", "durationMs": 60, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a27-ebc8-74ce-b84d-6f77805c3db1	019e2a27-ebc8-74ce-b84d-6f77805c3db1	\N	workflow-worker	1	1778823719880
019e2a27-ecda-76ce-8eaf-ee4027bfc37e	queue.job.started	default	{"jobId": "019e2a27-ecd1-734c-baed-bf50bb7a3ebe", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823720154, "workspaceId": "default"}	019e2a27-ecda-76ce-8eaf-ee4027bfc37e	019e2a27-ecda-76ce-8eaf-ee4027bfc37e	\N	workflow-worker	1	1778823720154
019e2a27-ece3-7127-9be1-3994d81e9959	workflow.run.started	default	{"runId": "019e2a27-ecd1-734c-baed-bf50bb7a3ebe", "traceId": "019e2a27-ecd1-734c-baed-c05113a4cb53"}	019e2a27-ece3-7127-9be1-3994d81e9959	019e2a27-ece3-7127-9be1-3994d81e9959	\N	workflow-worker	1	1778823720163
019e2a27-ed10-763d-b9c3-cb382907aa1e	workflow.step.completed	default	{"runId": "019e2a27-ecd1-734c-baed-bf50bb7a3ebe", "stepId": "s1", "traceId": "019e2a27-ecd1-734c-baed-c05113a4cb53"}	019e2a27-ed10-763d-b9c3-cb382907aa1e	019e2a27-ed10-763d-b9c3-cb382907aa1e	\N	workflow-worker	1	1778823720208
019e2a27-ed31-728b-98dd-53a6d129c743	queue.job.completed	default	{"jobId": "019e2a27-ecd1-734c-baed-bf50bb7a3ebe", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823720241, "durationMs": 90, "workspaceId": "default"}	019e2a27-ed31-728b-98dd-53a6d129c743	019e2a27-ed31-728b-98dd-53a6d129c743	\N	workflow-worker	1	1778823720241
019e2a27-ee69-72ef-b1db-8142a7078159	workflow.run.started	default	{"runId": "019e2a27-ee55-716e-b73e-47dff9244354", "traceId": "019e2a27-ee55-716e-b73e-489cdb9554a8"}	019e2a27-ee69-72ef-b1db-8142a7078159	019e2a27-ee69-72ef-b1db-8142a7078159	\N	workflow-worker	1	1778823720553
019e2a27-ee91-735d-9193-b9ebdd70fb8d	workflow.step.completed	default	{"runId": "019e2a27-ee55-716e-b73e-47dff9244354", "stepId": "s1", "traceId": "019e2a27-ee55-716e-b73e-489cdb9554a8"}	019e2a27-ee91-735d-9193-b9ebdd70fb8d	019e2a27-ee91-735d-9193-b9ebdd70fb8d	\N	workflow-worker	1	1778823720593
019e2a27-eeab-767b-8160-f6bea895a545	queue.job.completed	default	{"jobId": "019e2a27-ee55-716e-b73e-47dff9244354", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823720619, "durationMs": 78, "workspaceId": "default"}	019e2a27-eeab-767b-8160-f6bea895a545	019e2a27-eeab-767b-8160-f6bea895a545	\N	workflow-worker	1	1778823720619
019e2a27-efeb-73c7-a637-68e390328dd2	workflow.run.started	default	{"runId": "019e2a27-efd8-77bb-8d9b-728ff860c105", "traceId": "019e2a27-efd8-77bb-8d9b-7562dd76c055"}	019e2a27-efeb-73c7-a637-68e390328dd2	019e2a27-efeb-73c7-a637-68e390328dd2	\N	workflow-worker	1	1778823720939
019e2a27-f012-73dc-8306-a32fe84cbbce	workflow.step.completed	default	{"runId": "019e2a27-efd8-77bb-8d9b-728ff860c105", "stepId": "s1", "traceId": "019e2a27-efd8-77bb-8d9b-7562dd76c055"}	019e2a27-f012-73dc-8306-a32fe84cbbce	019e2a27-f012-73dc-8306-a32fe84cbbce	\N	workflow-worker	1	1778823720978
019e2a27-f034-71d8-ac3d-3760832a4bf5	queue.job.completed	default	{"jobId": "019e2a27-efd8-77bb-8d9b-728ff860c105", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823721012, "durationMs": 85, "workspaceId": "default"}	019e2a27-f034-71d8-ac3d-3760832a4bf5	019e2a27-f034-71d8-ac3d-3760832a4bf5	\N	workflow-worker	1	1778823721012
019e2a27-f144-70b1-9b9a-2ab8143210fd	workflow.run.started	default	{"runId": "019e2a27-f135-763e-89f1-9cfbf82a21c9", "traceId": "019e2a27-f135-763e-89f1-a3a33a781ce2"}	019e2a27-f144-70b1-9b9a-2ab8143210fd	019e2a27-f144-70b1-9b9a-2ab8143210fd	\N	workflow-worker	1	1778823721284
019e2a27-f184-720c-8bcd-54f2a545e98f	workflow.step.completed	default	{"runId": "019e2a27-f135-763e-89f1-9cfbf82a21c9", "stepId": "s1", "traceId": "019e2a27-f135-763e-89f1-a3a33a781ce2"}	019e2a27-f184-720c-8bcd-54f2a545e98f	019e2a27-f184-720c-8bcd-54f2a545e98f	\N	workflow-worker	1	1778823721348
019e2a1f-daf9-76af-8935-6e418ab62a35	recovery.checkpoint.created	default	{"runId": "019e2a1f-da6a-7695-8f18-5986320d4ebc", "stepId": "step1", "timestamp": 1778823191273, "workspaceId": "default", "checkpointId": "019e2a1f-dae9-7479-956f-343525287879"}	019e2a1f-da6a-7695-8f18-5d600625aa81	019e2a1f-da6a-7695-8f18-5d600625aa81	\N	recovery-service	1	1778823191289
019e2a27-ecd9-721d-b523-24e6478a871a	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-b119-773a-8bc3-d9e1a120f50e/run", "method": "POST", "requestId": "req-1z", "durationMs": 11, "statusCode": 202}	019e2a27-ecd9-721d-b523-288ed7a206fa	req-1z	\N	audit-plugin	1	1778823720153
019e2a27-ee5f-7248-8787-16b21ccbe3a5	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-b27e-72dc-b59c-c332d97f8734/run", "method": "POST", "requestId": "req-20", "durationMs": 12, "statusCode": 202}	019e2a27-ee5f-7248-8787-1932c72b48f7	req-20	\N	audit-plugin	1	1778823720543
019e2a27-efe1-700d-a0dd-af8d23942843	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-b3ed-75dc-89e0-b9645a5bf30d/run", "method": "POST", "requestId": "req-21", "durationMs": 11, "statusCode": 202}	019e2a27-efe1-700d-a0dd-b1491b4d2326	req-21	\N	audit-plugin	1	1778823720929
019e2a27-f13b-7274-985c-5ce4a4c1d5a8	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-b56e-737d-8753-a657760aafa3/run", "method": "POST", "requestId": "req-22", "durationMs": 8, "statusCode": 202}	019e2a27-f13b-7274-985c-60eb22678e05	req-22	\N	audit-plugin	1	1778823721275
019e2a27-f2bc-75aa-9f9f-9f905fd383cd	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-b6de-7236-ab35-c399c2e49629/run", "method": "POST", "requestId": "req-23", "durationMs": 12, "statusCode": 202}	019e2a27-f2bc-75aa-9f9f-a15d3f1e1f21	req-23	\N	audit-plugin	1	1778823721660
019e2a27-f314-7709-b644-684e34e297c4	workflow.run.completed	default	{"runId": "019e2a27-f2b4-75ff-89f8-4c68f77711fe", "traceId": "019e2a27-f2b4-75ff-89f8-501eba7413bd", "durationMs": 69, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a27-f314-7709-b644-684e34e297c4	019e2a27-f314-7709-b644-684e34e297c4	\N	workflow-worker	1	1778823721748
019e2a27-f427-7789-adac-592bdb07038a	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-b86c-763a-8a50-a98db01c2b89/run", "method": "POST", "requestId": "req-24", "durationMs": 9, "statusCode": 202}	019e2a27-f427-7789-adac-5c48a3e8e612	req-24	\N	audit-plugin	1	1778823722023
019e2a27-f428-703b-9c93-bb7f3badb1b3	queue.job.started	default	{"jobId": "019e2a27-f420-7482-a357-cc9aca9a86a0", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823722024, "workspaceId": "default"}	019e2a27-f428-703b-9c93-bb7f3badb1b3	019e2a27-f428-703b-9c93-bb7f3badb1b3	\N	workflow-worker	1	1778823722024
019e2a27-f430-7178-ab0d-143e5fe65626	workflow.run.started	default	{"runId": "019e2a27-f420-7482-a357-cc9aca9a86a0", "traceId": "019e2a27-f420-7482-a357-d307e0be459a"}	019e2a27-f430-7178-ab0d-143e5fe65626	019e2a27-f430-7178-ab0d-143e5fe65626	\N	workflow-worker	1	1778823722032
019e2a27-f457-7558-9316-c4c825281bab	workflow.step.completed	default	{"runId": "019e2a27-f420-7482-a357-cc9aca9a86a0", "stepId": "s1", "traceId": "019e2a27-f420-7482-a357-d307e0be459a"}	019e2a27-f457-7558-9316-c4c825281bab	019e2a27-f457-7558-9316-c4c825281bab	\N	workflow-worker	1	1778823722071
019e2a27-f48d-727f-a584-68f660cdb753	queue.job.completed	default	{"jobId": "019e2a27-f420-7482-a357-cc9aca9a86a0", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823722125, "durationMs": 103, "workspaceId": "default"}	019e2a27-f48d-727f-a584-68f660cdb753	019e2a27-f48d-727f-a584-68f660cdb753	\N	workflow-worker	1	1778823722125
019e2a28-6732-7540-b0c1-6eb74f662adf	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-b9e2-7329-a93c-659f7ab8f611/run", "method": "POST", "requestId": "req-2f", "durationMs": 13, "statusCode": 202}	019e2a28-6732-7540-b0c1-7078a3095f21	req-2f	\N	audit-plugin	1	1778823751474
019e2a28-6780-72be-a8af-fb0c193bae41	recovery.checkpoint.created	default	{"runId": "019e2a28-6728-71b9-aa98-5541ae7d8827", "stepId": "s1", "timestamp": 1778823751550, "workspaceId": "default", "checkpointId": "019e2a28-677e-7126-91f1-eb6e3565ba6d"}	019e2a28-6728-71b9-aa98-5a880110fecb	019e2a28-6728-71b9-aa98-5a880110fecb	\N	recovery-service	1	1778823751553
019e2a28-6791-70eb-87b0-c180666d26b7	workflow.run.completed	default	{"runId": "019e2a28-6728-71b9-aa98-5541ae7d8827", "traceId": "019e2a28-6728-71b9-aa98-5a880110fecb", "durationMs": 60, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a28-6791-70eb-87b0-c180666d26b7	019e2a28-6791-70eb-87b0-c180666d26b7	\N	workflow-worker	1	1778823751569
019e2a28-679a-72bc-86a0-44c1a5c6a108	queue.job.completed	default	{"jobId": "019e2a28-6728-71b9-aa98-5541ae7d8827", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823751578, "durationMs": 106, "workspaceId": "default"}	019e2a28-679a-72bc-86a0-44c1a5c6a108	019e2a28-679a-72bc-86a0-44c1a5c6a108	\N	workflow-worker	1	1778823751578
019e2a28-68bf-73c8-85fd-5a20d3087fe1	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-bb47-705a-8bbc-f0feeb2f3bfb/run", "method": "POST", "requestId": "req-2g", "durationMs": 8, "statusCode": 202}	019e2a28-68bf-73c8-85fd-5d5d5eebfd8b	req-2g	\N	audit-plugin	1	1778823751871
019e2a28-68c0-772e-9047-7d4425800113	queue.job.started	default	{"jobId": "019e2a28-68b9-7473-b384-992b3f8dae23", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823751872, "workspaceId": "default"}	019e2a28-68c0-772e-9047-7d4425800113	019e2a28-68c0-772e-9047-7d4425800113	\N	workflow-worker	1	1778823751872
019e2a28-68c8-76cc-8a46-276b37441a10	workflow.run.started	default	{"runId": "019e2a28-68b9-7473-b384-992b3f8dae23", "traceId": "019e2a28-68b9-7473-b384-9ce725ac3917"}	019e2a28-68c8-76cc-8a46-276b37441a10	019e2a28-68c8-76cc-8a46-276b37441a10	\N	workflow-worker	1	1778823751880
019e2a28-6901-727b-9be3-eff4dfffaabd	workflow.step.completed	default	{"runId": "019e2a28-68b9-7473-b384-992b3f8dae23", "stepId": "s1", "traceId": "019e2a28-68b9-7473-b384-9ce725ac3917"}	019e2a28-6901-727b-9be3-eff4dfffaabd	019e2a28-6901-727b-9be3-eff4dfffaabd	\N	workflow-worker	1	1778823751937
019e2a28-690d-7799-b0fd-15378e93c60c	recovery.checkpoint.created	default	{"runId": "019e2a28-68b9-7473-b384-992b3f8dae23", "stepId": "s1", "timestamp": 1778823751946, "workspaceId": "default", "checkpointId": "019e2a28-690a-726b-8af0-73d888cf28fb"}	019e2a28-68b9-7473-b384-9ce725ac3917	019e2a28-68b9-7473-b384-9ce725ac3917	\N	recovery-service	1	1778823751949
019e2a31-1433-7718-b35a-6dc5a2bcf19f	workflow.run.timeout	default	{"runId": "019e2a2f-dead-cafe-beef-deadbeef0001"}	019e2a31-1433-7718-b35a-6dc5a2bcf19f	019e2a31-1433-7718-b35a-6dc5a2bcf19f	\N	recovery-worker	1	1778824320052
019e2a27-3ce5-765c-bef9-956616a38a03	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-q", "durationMs": 18, "statusCode": 201}	019e2a27-3ce5-765c-bef9-9bed2366ad3d	req-q	\N	audit-plugin	1	1778823675109
019e2a27-3f2c-71ab-87a9-7798063bf8b1	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-r", "durationMs": 8, "statusCode": 201}	019e2a27-3f2c-71ab-87a9-7a0dcc3668cc	req-r	\N	audit-plugin	1	1778823675692
019e2a27-410c-740b-a591-80f376522f86	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-s", "durationMs": 9, "statusCode": 201}	019e2a27-410c-740b-a591-8570f9617482	req-s	\N	audit-plugin	1	1778823676172
019e2a1c-f261-7555-86eb-a3daba5ea232	analytics.ai-usage.aggregated	default	{"items": [{"date": "2026-05-15", "model": "claude-3-5-sonnet-20241022", "provider": "anthropic", "totalCost": 0.038, "totalReqs": 1, "totalTokens": 10220, "workspaceId": "default", "avgLatencyMs": 2340, "totalLatency": 2340}, {"date": "2026-05-14", "model": "claude-3-5-haiku-20241022", "provider": "anthropic", "totalCost": 0.006, "totalReqs": 1, "totalTokens": 3840, "workspaceId": "default", "avgLatencyMs": 820, "totalLatency": 820}, {"date": "2026-05-15", "model": "claude-3-5-sonnet", "provider": "anthropic", "totalCost": 0.0012, "totalReqs": 1, "totalTokens": 230, "workspaceId": "default", "avgLatencyMs": 850, "totalLatency": 850}], "aggregatedAt": 1778823000673}	019e2a1c-f262-7555-86eb-af81f4bae27d	019e2a1c-f262-7555-86eb-b1d9abcb71af	\N	analytics-worker	1	1778823000674
019e2a27-42d7-779e-bcdf-bb473f0387aa	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-t", "durationMs": 8, "statusCode": 201}	019e2a27-42d7-779e-bcdf-bc1ab60f1f5c	req-t	\N	audit-plugin	1	1778823676631
019e2a27-44bc-7328-b0ce-8e5afbf083bb	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-u", "durationMs": 11, "statusCode": 201}	019e2a27-44bc-7328-b0ce-911431a2569b	req-u	\N	audit-plugin	1	1778823677116
019e2a1c-f395-7495-b02c-bae353ba66b0	workflow.run.retry-scheduled	default	{"runId": "019e2a18-c41a-77db-b5b7-7d0605b1d852", "attempt": 2}	019e2a1c-f395-7495-b02c-bae353ba66b0	019e2a1c-f395-7495-b02c-bae353ba66b0	\N	recovery-worker	1	1778823000982
019e2a27-4697-7680-9268-90f98a2c790f	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-v", "durationMs": 9, "statusCode": 201}	019e2a27-4697-7680-9268-961b82630071	req-v	\N	audit-plugin	1	1778823677591
019e2a27-4888-71ff-b8f2-41aa92672d64	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-w", "durationMs": 11, "statusCode": 201}	019e2a27-4888-71ff-b8f2-476615ecc1a9	req-w	\N	audit-plugin	1	1778823678088
019e2a27-4a8c-74cf-ab4f-b5b74bebf27a	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-x", "durationMs": 9, "statusCode": 201}	019e2a27-4a8c-74cf-ab4f-baebc30aa8f4	req-x	\N	audit-plugin	1	1778823678604
019e2a27-4c5a-70e8-b3c1-b4749d101ba5	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-y", "durationMs": 9, "statusCode": 201}	019e2a27-4c5a-70e8-b3c1-babd6859700c	req-y	\N	audit-plugin	1	1778823679066
019e2a27-4e30-74eb-9786-8fb7e2b04064	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-z", "durationMs": 8, "statusCode": 201}	019e2a27-4e30-74eb-9786-9147d74b8616	req-z	\N	audit-plugin	1	1778823679536
019e2a27-501b-7198-8add-b71ad4e99e0d	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-10", "durationMs": 12, "statusCode": 201}	019e2a27-501b-7198-8add-bbc1280ec191	req-10	\N	audit-plugin	1	1778823680027
019e2a27-5201-7652-b836-98794dd524f5	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-11", "durationMs": 9, "statusCode": 201}	019e2a27-5201-7652-b836-9c14ea9840d2	req-11	\N	audit-plugin	1	1778823680513
019e2a27-53e5-7198-b68b-e77dbbc387da	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-12", "durationMs": 9, "statusCode": 201}	019e2a27-53e5-7198-b68b-e9ec4670bfe3	req-12	\N	audit-plugin	1	1778823680997
019e2a27-55bc-76ca-9b73-dcad087746e5	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-13", "durationMs": 8, "statusCode": 201}	019e2a27-55bc-76ca-9b73-e1b6669c22f0	req-13	\N	audit-plugin	1	1778823681468
019e2a27-5798-71af-afbc-a0187fbcf7fc	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-14", "durationMs": 8, "statusCode": 201}	019e2a27-5798-71af-afbc-a637d855214a	req-14	\N	audit-plugin	1	1778823681944
019e2a27-5995-761e-8849-1b9b0ba10974	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-15", "durationMs": 9, "statusCode": 201}	019e2a27-5995-761e-8849-1f709d578c60	req-15	\N	audit-plugin	1	1778823682453
019e2a27-5b66-70fb-94f5-435876e9a44b	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-16", "durationMs": 8, "statusCode": 201}	019e2a27-5b66-70fb-94f5-47a96bbde6c9	req-16	\N	audit-plugin	1	1778823682918
019e2a27-5d2c-761e-873f-c9168d2c9b51	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-17", "durationMs": 9, "statusCode": 201}	019e2a27-5d2c-761e-873f-cfde80d53690	req-17	\N	audit-plugin	1	1778823683372
019e2a27-5ef8-745d-96f3-b4ec5d7c6bb2	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-18", "durationMs": 8, "statusCode": 201}	019e2a27-5ef8-745d-96f3-b8373a543d84	req-18	\N	audit-plugin	1	1778823683832
019e2a27-60d4-7510-b7c9-738939e47e6d	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-19", "durationMs": 9, "statusCode": 201}	019e2a27-60d4-7510-b7c9-751e4cb22b14	req-19	\N	audit-plugin	1	1778823684308
019e2a27-7a44-700b-8be3-1c9998803cc4	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-1a", "durationMs": 9, "statusCode": 201}	019e2a27-7a44-700b-8be3-21df1447f21f	req-1a	\N	audit-plugin	1	1778823690820
019e2a27-f1a1-717d-ae6a-477f77b8cdec	queue.job.completed	default	{"jobId": "019e2a27-f135-763e-89f1-9cfbf82a21c9", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823721377, "durationMs": 104, "workspaceId": "default"}	019e2a27-f1a1-717d-ae6a-477f77b8cdec	019e2a27-f1a1-717d-ae6a-477f77b8cdec	\N	workflow-worker	1	1778823721377
019e2a28-6915-771c-b6da-516e15ce052f	workflow.run.completed	default	{"runId": "019e2a28-68b9-7473-b384-992b3f8dae23", "traceId": "019e2a28-68b9-7473-b384-9ce725ac3917", "durationMs": 65, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a28-6915-771c-b6da-516e15ce052f	019e2a28-6915-771c-b6da-516e15ce052f	\N	workflow-worker	1	1778823751957
019e2a28-6a2b-71da-9aeb-6ea970c9f89b	queue.job.started	default	{"jobId": "019e2a28-6a24-70ed-a172-134d40f5840a", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823752235, "workspaceId": "default"}	019e2a28-6a2b-71da-9aeb-6ea970c9f89b	019e2a28-6a2b-71da-9aeb-6ea970c9f89b	\N	workflow-worker	1	1778823752235
019e2a28-6a31-75ae-b3af-801b167f5710	workflow.run.started	default	{"runId": "019e2a28-6a24-70ed-a172-134d40f5840a", "traceId": "019e2a28-6a24-70ed-a172-17b01950a6d8"}	019e2a28-6a31-75ae-b3af-801b167f5710	019e2a28-6a31-75ae-b3af-801b167f5710	\N	workflow-worker	1	1778823752241
019e2a28-6a55-73bd-a9e8-c37141c1e4f8	workflow.step.completed	default	{"runId": "019e2a28-6a24-70ed-a172-134d40f5840a", "stepId": "s1", "traceId": "019e2a28-6a24-70ed-a172-17b01950a6d8"}	019e2a28-6a55-73bd-a9e8-c37141c1e4f8	019e2a28-6a55-73bd-a9e8-c37141c1e4f8	\N	workflow-worker	1	1778823752277
019e2a28-6a74-70a6-8f52-b2ddd90847d6	queue.job.completed	default	{"jobId": "019e2a28-6a24-70ed-a172-134d40f5840a", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823752308, "durationMs": 75, "workspaceId": "default"}	019e2a28-6a74-70a6-8f52-b2ddd90847d6	019e2a28-6a74-70a6-8f52-b2ddd90847d6	\N	workflow-worker	1	1778823752308
019e2a28-6c00-7402-8954-e6daaf57d5c8	workflow.run.completed	default	{"runId": "019e2a28-6ba8-764a-8dab-cc0cd36719c5", "traceId": "019e2a28-6ba8-764a-8dab-d389e1bb96b1", "durationMs": 57, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a28-6c00-7402-8954-e6daaf57d5c8	019e2a28-6c00-7402-8954-e6daaf57d5c8	\N	workflow-worker	1	1778823752704
019e2a28-6d43-714f-b04d-ce329c9698cb	queue.job.started	default	{"jobId": "019e2a28-6d38-77fa-8f1e-d39c173ef939", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823753027, "workspaceId": "default"}	019e2a28-6d43-714f-b04d-ce329c9698cb	019e2a28-6d43-714f-b04d-ce329c9698cb	\N	workflow-worker	1	1778823753027
019e2a28-6da1-743c-b936-f45955a73769	workflow.run.completed	default	{"runId": "019e2a28-6d38-77fa-8f1e-d39c173ef939", "traceId": "019e2a28-6d38-77fa-8f1e-d72e5d8f5586", "durationMs": 75, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a28-6da1-743c-b936-f45955a73769	019e2a28-6da1-743c-b936-f45955a73769	\N	workflow-worker	1	1778823753121
019e2a28-6ec4-741f-be0b-2dd790cd3c56	queue.job.started	default	{"jobId": "019e2a28-6eba-756e-8b38-cd5ab01cc825", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823753412, "workspaceId": "default"}	019e2a28-6ec4-741f-be0b-2dd790cd3c56	019e2a28-6ec4-741f-be0b-2dd790cd3c56	\N	workflow-worker	1	1778823753412
019e2a28-6f12-7009-9d42-2ab5e1685a7a	workflow.run.completed	default	{"runId": "019e2a28-6eba-756e-8b38-cd5ab01cc825", "traceId": "019e2a28-6eba-756e-8b38-d3ee2efaf506", "durationMs": 53, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a28-6f12-7009-9d42-2ab5e1685a7a	019e2a28-6f12-7009-9d42-2ab5e1685a7a	\N	workflow-worker	1	1778823753490
019e2a28-701f-7616-bf02-de9c10547b94	queue.job.started	default	{"jobId": "019e2a28-7015-70d4-a603-728242725f76", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823753759, "workspaceId": "default"}	019e2a28-701f-7616-bf02-de9c10547b94	019e2a28-701f-7616-bf02-de9c10547b94	\N	workflow-worker	1	1778823753760
019e2a28-706f-7793-b8bc-74ebf09cb5ff	workflow.run.completed	default	{"runId": "019e2a28-7015-70d4-a603-728242725f76", "traceId": "019e2a28-7015-70d4-a603-740c0f7040fc", "durationMs": 53, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a28-706f-7793-b8bc-74ebf09cb5ff	019e2a28-706f-7793-b8bc-74ebf09cb5ff	\N	workflow-worker	1	1778823753839
019e2a28-7193-7530-8b36-b2e9362b872d	queue.job.started	default	{"jobId": "019e2a28-718b-76db-a7ae-eae07ef816c0", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823754131, "workspaceId": "default"}	019e2a28-7193-7530-8b36-b2e9362b872d	019e2a28-7193-7530-8b36-b2e9362b872d	\N	workflow-worker	1	1778823754131
019e2a28-719a-7454-916d-21d9d015b152	workflow.run.started	default	{"runId": "019e2a28-718b-76db-a7ae-eae07ef816c0", "traceId": "019e2a28-718b-76db-a7ae-ede6dac1c055"}	019e2a28-719a-7454-916d-21d9d015b152	019e2a28-719a-7454-916d-21d9d015b152	\N	workflow-worker	1	1778823754138
019e2a28-71dc-73de-a4bc-61310271586e	workflow.step.completed	default	{"runId": "019e2a28-718b-76db-a7ae-eae07ef816c0", "stepId": "s1", "traceId": "019e2a28-718b-76db-a7ae-ede6dac1c055"}	019e2a28-71dc-73de-a4bc-61310271586e	019e2a28-71dc-73de-a4bc-61310271586e	\N	workflow-worker	1	1778823754204
019e2a28-71fa-703b-b4d2-7583886a502d	queue.job.completed	default	{"jobId": "019e2a28-718b-76db-a7ae-eae07ef816c0", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823754234, "durationMs": 105, "workspaceId": "default"}	019e2a28-71fa-703b-b4d2-7583886a502d	019e2a28-71fa-703b-b4d2-7583886a502d	\N	workflow-worker	1	1778823754234
019e2a28-7371-7755-b86b-f1a64a3726bf	workflow.run.completed	default	{"runId": "019e2a28-730d-7229-84d8-bf4667b361ae", "traceId": "019e2a28-730d-7229-84d8-c10e6812af0a", "durationMs": 53, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a28-7371-7755-b86b-f1a64a3726bf	019e2a28-7371-7755-b86b-f1a64a3726bf	\N	workflow-worker	1	1778823754609
019e2a28-748e-7193-a3ee-47d96aded7b4	queue.job.started	default	{"jobId": "019e2a28-7482-7564-8317-65cfabf5f758", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823754894, "workspaceId": "default"}	019e2a28-748e-7193-a3ee-47d96aded7b4	019e2a28-748e-7193-a3ee-47d96aded7b4	\N	workflow-worker	1	1778823754894
019e2a28-7496-716b-9f98-1b7aa98cbc8f	workflow.run.started	default	{"runId": "019e2a28-7482-7564-8317-65cfabf5f758", "traceId": "019e2a28-7482-7564-8317-6bcbb6775255"}	019e2a28-7496-716b-9f98-1b7aa98cbc8f	019e2a28-7496-716b-9f98-1b7aa98cbc8f	\N	workflow-worker	1	1778823754902
019e2a28-74bb-70d8-a490-66787dce7573	workflow.step.completed	default	{"runId": "019e2a28-7482-7564-8317-65cfabf5f758", "stepId": "s1", "traceId": "019e2a28-7482-7564-8317-6bcbb6775255"}	019e2a28-74bb-70d8-a490-66787dce7573	019e2a28-74bb-70d8-a490-66787dce7573	\N	workflow-worker	1	1778823754939
019e2a28-6920-74ab-9ecc-e7eb345b13e4	queue.job.completed	default	{"jobId": "019e2a28-68b9-7473-b384-992b3f8dae23", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823751968, "durationMs": 98, "workspaceId": "default"}	019e2a28-6920-74ab-9ecc-e7eb345b13e4	019e2a28-6920-74ab-9ecc-e7eb345b13e4	\N	workflow-worker	1	1778823751968
019e2a28-6a6b-75ae-a9b9-32b61fecf06d	workflow.run.completed	default	{"runId": "019e2a28-6a24-70ed-a172-134d40f5840a", "traceId": "019e2a28-6a24-70ed-a172-17b01950a6d8", "durationMs": 47, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a28-6a6b-75ae-a9b9-32b61fecf06d	019e2a28-6a6b-75ae-a9b9-32b61fecf06d	\N	workflow-worker	1	1778823752299
019e2a28-6bb3-7509-9140-9d0f93567ce2	queue.job.started	default	{"jobId": "019e2a28-6ba8-764a-8dab-cc0cd36719c5", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823752627, "workspaceId": "default"}	019e2a28-6bb3-7509-9140-9d0f93567ce2	019e2a28-6bb3-7509-9140-9d0f93567ce2	\N	workflow-worker	1	1778823752627
019e2a28-6bbb-72b9-bbb7-73fc137221d2	workflow.run.started	default	{"runId": "019e2a28-6ba8-764a-8dab-cc0cd36719c5", "traceId": "019e2a28-6ba8-764a-8dab-d389e1bb96b1"}	019e2a28-6bbb-72b9-bbb7-73fc137221d2	019e2a28-6bbb-72b9-bbb7-73fc137221d2	\N	workflow-worker	1	1778823752635
019e2a28-6bed-70bb-88bd-3f1e89f6b5bc	workflow.step.completed	default	{"runId": "019e2a28-6ba8-764a-8dab-cc0cd36719c5", "stepId": "s1", "traceId": "019e2a28-6ba8-764a-8dab-d389e1bb96b1"}	019e2a28-6bed-70bb-88bd-3f1e89f6b5bc	019e2a28-6bed-70bb-88bd-3f1e89f6b5bc	\N	workflow-worker	1	1778823752685
019e2a28-6c08-74dc-b049-5c153db5eee5	queue.job.completed	default	{"jobId": "019e2a28-6ba8-764a-8dab-cc0cd36719c5", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823752712, "durationMs": 88, "workspaceId": "default"}	019e2a28-6c08-74dc-b049-5c153db5eee5	019e2a28-6c08-74dc-b049-5c153db5eee5	\N	workflow-worker	1	1778823752712
019e2a28-6d4b-773a-ad72-e4354381c65b	workflow.run.started	default	{"runId": "019e2a28-6d38-77fa-8f1e-d39c173ef939", "traceId": "019e2a28-6d38-77fa-8f1e-d72e5d8f5586"}	019e2a28-6d4b-773a-ad72-e4354381c65b	019e2a28-6d4b-773a-ad72-e4354381c65b	\N	workflow-worker	1	1778823753035
019e2a28-6d8a-72e8-9b4f-f5a2eba96b17	workflow.step.completed	default	{"runId": "019e2a28-6d38-77fa-8f1e-d39c173ef939", "stepId": "s1", "traceId": "019e2a28-6d38-77fa-8f1e-d72e5d8f5586"}	019e2a28-6d8a-72e8-9b4f-f5a2eba96b17	019e2a28-6d8a-72e8-9b4f-f5a2eba96b17	\N	workflow-worker	1	1778823753098
019e2a28-6dab-7659-a9d7-f49e175a130a	queue.job.completed	default	{"jobId": "019e2a28-6d38-77fa-8f1e-d39c173ef939", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823753131, "durationMs": 107, "workspaceId": "default"}	019e2a28-6dab-7659-a9d7-f49e175a130a	019e2a28-6dab-7659-a9d7-f49e175a130a	\N	workflow-worker	1	1778823753131
019e2a28-6ecf-76f7-8778-9ac0c689ffee	workflow.run.started	default	{"runId": "019e2a28-6eba-756e-8b38-cd5ab01cc825", "traceId": "019e2a28-6eba-756e-8b38-d3ee2efaf506"}	019e2a28-6ecf-76f7-8778-9ac0c689ffee	019e2a28-6ecf-76f7-8778-9ac0c689ffee	\N	workflow-worker	1	1778823753423
019e2a28-6efb-7209-af25-2a9f210d998d	workflow.step.completed	default	{"runId": "019e2a28-6eba-756e-8b38-cd5ab01cc825", "stepId": "s1", "traceId": "019e2a28-6eba-756e-8b38-d3ee2efaf506"}	019e2a28-6efb-7209-af25-2a9f210d998d	019e2a28-6efb-7209-af25-2a9f210d998d	\N	workflow-worker	1	1778823753467
019e2a28-6f1a-721b-9a04-5e483e91ac20	queue.job.completed	default	{"jobId": "019e2a28-6eba-756e-8b38-cd5ab01cc825", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823753498, "durationMs": 89, "workspaceId": "default"}	019e2a28-6f1a-721b-9a04-5e483e91ac20	019e2a28-6f1a-721b-9a04-5e483e91ac20	\N	workflow-worker	1	1778823753498
019e2a28-702e-743a-81c1-61883793bdfc	workflow.run.started	default	{"runId": "019e2a28-7015-70d4-a603-728242725f76", "traceId": "019e2a28-7015-70d4-a603-740c0f7040fc"}	019e2a28-702e-743a-81c1-61883793bdfc	019e2a28-702e-743a-81c1-61883793bdfc	\N	workflow-worker	1	1778823753774
019e2a28-705a-726b-ae4f-0b14ece352cd	workflow.step.completed	default	{"runId": "019e2a28-7015-70d4-a603-728242725f76", "stepId": "s1", "traceId": "019e2a28-7015-70d4-a603-740c0f7040fc"}	019e2a28-705a-726b-ae4f-0b14ece352cd	019e2a28-705a-726b-ae4f-0b14ece352cd	\N	workflow-worker	1	1778823753818
019e2a28-7079-722f-a0aa-4040ee334914	queue.job.completed	default	{"jobId": "019e2a28-7015-70d4-a603-728242725f76", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823753849, "durationMs": 93, "workspaceId": "default"}	019e2a28-7079-722f-a0aa-4040ee334914	019e2a28-7079-722f-a0aa-4040ee334914	\N	workflow-worker	1	1778823753849
019e2a28-71f0-74eb-a986-7c9c5fb163a2	workflow.run.completed	default	{"runId": "019e2a28-718b-76db-a7ae-eae07ef816c0", "traceId": "019e2a28-718b-76db-a7ae-ede6dac1c055", "durationMs": 74, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a28-71f0-74eb-a986-7c9c5fb163a2	019e2a28-71f0-74eb-a986-7c9c5fb163a2	\N	workflow-worker	1	1778823754224
019e2a28-7317-7592-b354-0fb0d5928e82	queue.job.started	default	{"jobId": "019e2a28-730d-7229-84d8-bf4667b361ae", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823754519, "workspaceId": "default"}	019e2a28-7317-7592-b354-0fb0d5928e82	019e2a28-7317-7592-b354-0fb0d5928e82	\N	workflow-worker	1	1778823754519
019e2a28-732e-7651-9ec6-488813afb2f7	workflow.run.started	default	{"runId": "019e2a28-730d-7229-84d8-bf4667b361ae", "traceId": "019e2a28-730d-7229-84d8-c10e6812af0a"}	019e2a28-732e-7651-9ec6-488813afb2f7	019e2a28-732e-7651-9ec6-488813afb2f7	\N	workflow-worker	1	1778823754542
019e2a28-735c-77ab-8d39-aa4d68353af6	workflow.step.completed	default	{"runId": "019e2a28-730d-7229-84d8-bf4667b361ae", "stepId": "s1", "traceId": "019e2a28-730d-7229-84d8-c10e6812af0a"}	019e2a28-735c-77ab-8d39-aa4d68353af6	019e2a28-735c-77ab-8d39-aa4d68353af6	\N	workflow-worker	1	1778823754588
019e2a28-737a-779b-899f-ed22a5d03c7c	queue.job.completed	default	{"jobId": "019e2a28-730d-7229-84d8-bf4667b361ae", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823754618, "durationMs": 102, "workspaceId": "default"}	019e2a28-737a-779b-899f-ed22a5d03c7c	019e2a28-737a-779b-899f-ed22a5d03c7c	\N	workflow-worker	1	1778823754618
019e2a28-74cd-772d-92ca-700096b595fa	workflow.run.completed	default	{"runId": "019e2a28-7482-7564-8317-65cfabf5f758", "traceId": "019e2a28-7482-7564-8317-6bcbb6775255", "durationMs": 46, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2a28-74cd-772d-92ca-700096b595fa	019e2a28-74cd-772d-92ca-700096b595fa	\N	workflow-worker	1	1778823754957
019e2a28-6a5f-723a-84ce-e8e1e46b7701	recovery.checkpoint.created	default	{"runId": "019e2a28-6a24-70ed-a172-134d40f5840a", "stepId": "s1", "timestamp": 1778823752283, "workspaceId": "default", "checkpointId": "019e2a28-6a5b-765c-9151-977f9bc2089d"}	019e2a28-6a24-70ed-a172-17b01950a6d8	019e2a28-6a24-70ed-a172-17b01950a6d8	\N	recovery-service	1	1778823752287
019e2a28-6bf9-7623-b556-763be5206c46	recovery.checkpoint.created	default	{"runId": "019e2a28-6ba8-764a-8dab-cc0cd36719c5", "stepId": "s1", "timestamp": 1778823752693, "workspaceId": "default", "checkpointId": "019e2a28-6bf5-775e-a102-784d686651b9"}	019e2a28-6ba8-764a-8dab-d389e1bb96b1	019e2a28-6ba8-764a-8dab-d389e1bb96b1	\N	recovery-service	1	1778823752697
019e2a28-6d99-7564-8242-893100de8577	recovery.checkpoint.created	default	{"runId": "019e2a28-6d38-77fa-8f1e-d39c173ef939", "stepId": "s1", "timestamp": 1778823753109, "workspaceId": "default", "checkpointId": "019e2a28-6d95-71b9-bbac-8c48e0eb725c"}	019e2a28-6d38-77fa-8f1e-d72e5d8f5586	019e2a28-6d38-77fa-8f1e-d72e5d8f5586	\N	recovery-service	1	1778823753113
019e2a28-6f07-70ab-be65-ab57d904e011	recovery.checkpoint.created	default	{"runId": "019e2a28-6eba-756e-8b38-cd5ab01cc825", "stepId": "s1", "timestamp": 1778823753474, "workspaceId": "default", "checkpointId": "019e2a28-6f02-775e-81f0-8ce5a7b7be76"}	019e2a28-6eba-756e-8b38-d3ee2efaf506	019e2a28-6eba-756e-8b38-d3ee2efaf506	\N	recovery-service	1	1778823753479
019e2a28-7066-700b-9ec0-39d185836c80	recovery.checkpoint.created	default	{"runId": "019e2a28-7015-70d4-a603-728242725f76", "stepId": "s1", "timestamp": 1778823753827, "workspaceId": "default", "checkpointId": "019e2a28-7063-77d9-9699-c739d4d55f1d"}	019e2a28-7015-70d4-a603-740c0f7040fc	019e2a28-7015-70d4-a603-740c0f7040fc	\N	recovery-service	1	1778823753830
019e2a28-71e6-716e-97cb-c81a797270b5	recovery.checkpoint.created	default	{"runId": "019e2a28-718b-76db-a7ae-eae07ef816c0", "stepId": "s1", "timestamp": 1778823754211, "workspaceId": "default", "checkpointId": "019e2a28-71e3-7763-adc0-50199de7c932"}	019e2a28-718b-76db-a7ae-ede6dac1c055	019e2a28-718b-76db-a7ae-ede6dac1c055	\N	recovery-service	1	1778823754215
019e2a28-7368-725f-b694-74adab5b6cdc	recovery.checkpoint.created	default	{"runId": "019e2a28-730d-7229-84d8-bf4667b361ae", "stepId": "s1", "timestamp": 1778823754596, "workspaceId": "default", "checkpointId": "019e2a28-7364-74fb-9b3a-a8a76f603938"}	019e2a28-730d-7229-84d8-c10e6812af0a	019e2a28-730d-7229-84d8-c10e6812af0a	\N	recovery-service	1	1778823754600
019e2a28-74c5-771a-87c2-64902775879a	recovery.checkpoint.created	default	{"runId": "019e2a28-7482-7564-8317-65cfabf5f758", "stepId": "s1", "timestamp": 1778823754947, "workspaceId": "default", "checkpointId": "019e2a28-74c3-722f-9c55-316a812e3f99"}	019e2a28-7482-7564-8317-6bcbb6775255	019e2a28-7482-7564-8317-6bcbb6775255	\N	recovery-service	1	1778823754949
019e2a28-6bb1-749a-8a89-20996ad357af	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-be13-7188-8c61-86b20a9912d5/run", "method": "POST", "requestId": "req-2i", "durationMs": 12, "statusCode": 202}	019e2a28-6bb1-749a-8a89-27cabb78f34e	req-2i	\N	audit-plugin	1	1778823752626
019e2a28-6d42-70ba-a2b6-71ec18b0068a	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-bf91-717d-82f9-b529c3088dfe/run", "method": "POST", "requestId": "req-2j", "durationMs": 13, "statusCode": 202}	019e2a28-6d42-70ba-a2b6-77360e7b8a90	req-2j	\N	audit-plugin	1	1778823753026
019e2a28-6ec3-70fe-a722-27746cb46e07	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-c102-7520-a5d9-ac2632a345a6/run", "method": "POST", "requestId": "req-2k", "durationMs": 12, "statusCode": 202}	019e2a28-6ec3-70fe-a722-291c940c30be	req-2k	\N	audit-plugin	1	1778823753411
019e2a28-701e-7021-9c10-bcd33225454e	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-c274-71c0-9bf3-268e44d35639/run", "method": "POST", "requestId": "req-2l", "durationMs": 12, "statusCode": 202}	019e2a28-701e-7021-9c10-c3935b2a38b2	req-2l	\N	audit-plugin	1	1778823753758
019e2a28-7193-709f-b987-8fe9f8cec85a	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-c3fa-7446-aedb-25dbcb892a9d/run", "method": "POST", "requestId": "req-2m", "durationMs": 11, "statusCode": 202}	019e2a28-7193-709f-b987-904ddeca4753	req-2m	\N	audit-plugin	1	1778823754131
019e2a28-7315-77ba-ae84-1e453433e864	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-c56a-70e9-85ea-7b99dd6a1be9/run", "method": "POST", "requestId": "req-2n", "durationMs": 11, "statusCode": 202}	019e2a28-7315-77ba-ae84-21b5d28d7a36	req-2n	\N	audit-plugin	1	1778823754517
019e2a28-748d-73d7-ae9f-bf37b7b56dbe	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-c6ec-72eb-a1a3-96a31c05aeb4/run", "method": "POST", "requestId": "req-2o", "durationMs": 14, "statusCode": 202}	019e2a28-748d-73d7-ae9f-c1a32b091710	req-2o	\N	audit-plugin	1	1778823754893
019e2a28-74d5-7469-8f67-984ba5d72182	queue.job.completed	default	{"jobId": "019e2a28-7482-7564-8317-65cfabf5f758", "jobName": "execute-workflow", "workerId": "workflow-worker-4912", "queueName": "workflow", "timestamp": 1778823754965, "durationMs": 74, "workspaceId": "default"}	019e2a28-74d5-7469-8f67-984ba5d72182	019e2a28-74d5-7469-8f67-984ba5d72182	\N	workflow-worker	1	1778823754965
019e2a28-a19c-7509-9eec-3e7a255267d2	queue.job.started	default	{"jobId": "019e2a28-a166-70e9-a7ba-f4441c04191c", "attempt": 1, "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823766428, "workspaceId": "default"}	019e2a28-a19c-7509-9eec-43f044b22653	019e2a28-a19c-7509-9eec-44877bab63c7	\N	briefing-worker	1	1778823766428
019e2a28-a20d-7541-a3da-15521850b282	briefing.generated	default	{"traceId": "019e2a28-a166-70e9-a7ba-f1ece17e0c2c", "sections": ["top_priorities", "risks", "opportunities", "next_actions"], "itemCount": 19, "timestamp": 1778823766541, "briefingId": "019e2a28-a1a0-701c-a8d9-7927204cdb97", "durationMs": 109, "requestedBy": "user", "workspaceId": "default"}	019e2a28-a20d-7541-a3da-1832c643d1f2	019e2a28-a20d-7541-a3da-1e70ac2ba678	\N	briefing-worker	1	1778823766541
019e2a28-a23d-770e-b093-a16060758a8b	queue.job.completed	default	{"jobId": "019e2a28-a166-70e9-a7ba-f4441c04191c", "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823766589, "durationMs": 210, "workspaceId": "default"}	019e2a28-a23d-770e-b093-a5fd4bf2c1cd	019e2a28-a23d-770e-b093-a97df6cfdbca	\N	briefing-worker	1	1778823766589
019e2a28-a328-7128-a77d-954303f2327d	queue.job.started	default	{"jobId": "019e2a28-a321-747f-b481-7452cbd52bd2", "attempt": 1, "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823766824, "workspaceId": "default"}	019e2a28-a328-7128-a77d-99aaf6e1ff72	019e2a28-a328-7128-a77d-9def72ca581f	\N	briefing-worker	1	1778823766824
019e2a28-a345-760f-8921-9ab5019da872	briefing.generated	default	{"traceId": "019e2a28-a321-747f-b481-71a1d4a95e64", "sections": ["top_priorities", "risks", "opportunities", "next_actions"], "itemCount": 19, "timestamp": 1778823766853, "briefingId": "019e2a28-a329-7195-8405-1c02642c8bfd", "durationMs": 28, "requestedBy": "user", "workspaceId": "default"}	019e2a28-a345-760f-8921-9d4fcc79a010	019e2a28-a345-760f-8921-a0a470926e11	\N	briefing-worker	1	1778823766853
019e2a28-a34a-778f-bc0c-5497178fb9f4	queue.job.completed	default	{"jobId": "019e2a28-a321-747f-b481-7452cbd52bd2", "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823766858, "durationMs": 37, "workspaceId": "default"}	019e2a28-a34a-778f-bc0c-5b4f56efe4a9	019e2a28-a34a-778f-bc0c-5c7c004ce678	\N	briefing-worker	1	1778823766858
019e2a28-a48b-764f-8882-2394ceb677e4	queue.job.started	default	{"jobId": "019e2a28-a483-76cf-ad55-17bf9d5649e6", "attempt": 1, "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823767179, "workspaceId": "default"}	019e2a28-a48b-764f-8882-258b53ce6c42	019e2a28-a48b-764f-8882-2a25b004e726	\N	briefing-worker	1	1778823767179
019e2a28-a4a2-7049-b757-c91eda1a5c2b	briefing.generated	default	{"traceId": "019e2a28-a483-76cf-ad55-107ebb6032ab", "sections": ["top_priorities", "risks", "opportunities", "next_actions"], "itemCount": 19, "timestamp": 1778823767202, "briefingId": "019e2a28-a48b-764f-8882-2c4f29d249a1", "durationMs": 23, "requestedBy": "user", "workspaceId": "default"}	019e2a28-a4a2-7049-b757-cda065395800	019e2a28-a4a2-7049-b757-d22dcca856bf	\N	briefing-worker	1	1778823767202
019e2a28-a4a7-741e-b7d2-7235b6daf265	queue.job.completed	default	{"jobId": "019e2a28-a483-76cf-ad55-17bf9d5649e6", "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823767207, "durationMs": 32, "workspaceId": "default"}	019e2a28-a4a7-741e-b7d2-74f5b78f2014	019e2a28-a4a7-741e-b7d2-788605cb1cb1	\N	briefing-worker	1	1778823767207
019e2a28-b69d-73c3-a0ba-002a72be5288	queue.job.started	default	{"jobId": "019e2a28-b695-75ef-b9c4-5d922f1a98c0", "attempt": 1, "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823771805, "workspaceId": "default"}	019e2a28-b69d-73c3-a0ba-04f54b98414c	019e2a28-b69d-73c3-a0ba-0b019b5ec004	\N	briefing-worker	1	1778823771805
019e2a28-b6c4-7789-866c-dce9c932fed4	briefing.generated	default	{"traceId": "019e2a28-b695-75ef-b9c4-59214a110d89", "sections": ["top_priorities", "risks", "opportunities", "next_actions"], "itemCount": 19, "timestamp": 1778823771844, "briefingId": "019e2a28-b69e-7756-84cd-d5631c2cd868", "durationMs": 38, "requestedBy": "user", "workspaceId": "default"}	019e2a28-b6c4-7789-866c-e0e258e0c7e3	019e2a28-b6c4-7789-866c-e4f9367f368f	\N	briefing-worker	1	1778823771844
019e2a28-b6cb-71d9-b10a-1369213c51cd	queue.job.completed	default	{"jobId": "019e2a28-b695-75ef-b9c4-5d922f1a98c0", "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823771851, "durationMs": 49, "workspaceId": "default"}	019e2a28-b6cb-71d9-b10a-154bea7cc4b6	019e2a28-b6cb-71d9-b10a-1a7df8077063	\N	briefing-worker	1	1778823771851
019e2a28-ebeb-74b4-a6ff-fc2b99016620	memory.created	default	{"tags": [], "type": "observation", "memoryId": "019e2a28-ebe1-7783-a333-b87042cfdb44", "workspaceId": "default"}	019e2a28-ebeb-74b4-a700-02bb14296019	019e2a28-ebeb-74b4-a700-04af996508d7	\N	api	1	1778823785451
019e2a28-ebed-7995-997b-6ee0447479dd	queue.job.started	default	{"jobId": "8", "attempt": 1, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823785453, "workspaceId": "default"}	019e2a28-ebed-7995-997b-76fec4c9ff14	019e2a28-ebed-7995-997b-78316e463810	\N	memory-worker	1	1778823785453
019e2a28-ec23-7995-997b-9824390f6c65	queue.job.retry_scheduled	default	{"jobId": "8", "attempt": 2, "delayMs": 4000, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823785507, "workspaceId": "default"}	019e2a28-ec23-7995-997b-a2e3601eadef	019e2a28-ec23-7995-997b-ac353c7c62f4	\N	memory-worker	1	1778823785507
019e2a28-ec23-7995-997b-807d5b10ce13	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "8", "jobName": "embed-memory", "attempts": 1, "workerId": "memory-worker-2976", "exhausted": false, "queueName": "memory", "timestamp": 1778823785507, "workspaceId": "default"}	019e2a28-ec23-7995-997b-8ead0afcabfe	019e2a28-ec23-7995-997b-92b6019b78c0	\N	memory-worker	1	1778823785507
019e2a28-edcb-7217-b273-6fade01fb59e	memory.created	default	{"tags": [], "type": "decision", "memoryId": "019e2a28-edc5-7298-87e9-cae28715a4bb", "workspaceId": "default"}	019e2a28-edcb-7217-b273-71259f77ce37	019e2a28-edcb-7217-b273-74f61bec48c6	\N	api	1	1778823785931
019e2a28-edcd-7995-997b-b5f159378b25	queue.job.started	default	{"jobId": "9", "attempt": 1, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823785933, "workspaceId": "default"}	019e2a28-edcd-7995-997b-bbe609c596cf	019e2a28-edcd-7995-997b-c4bb76ba53b7	\N	memory-worker	1	1778823785933
019e2a28-efb4-7995-997b-fc4f45f7ec87	queue.job.started	default	{"jobId": "10", "attempt": 1, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823786420, "workspaceId": "default"}	019e2a28-efb4-7995-997c-03d12400e365	019e2a28-efb4-7995-997c-0a6912a8cefd	\N	memory-worker	1	1778823786420
019e2a28-f198-7995-997c-4564ef9f46b1	queue.job.started	default	{"jobId": "11", "attempt": 1, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823786904, "workspaceId": "default"}	019e2a28-f198-7995-997c-4cdfa9855919	019e2a28-f198-7995-997c-52235b46621c	\N	memory-worker	1	1778823786904
019e2a28-f35a-7995-997c-8b701176313e	queue.job.started	default	{"jobId": "12", "attempt": 1, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823787354, "workspaceId": "default"}	019e2a28-f35a-7995-997c-97757a01287f	019e2a28-f35a-7995-997c-9b0231f07d28	\N	memory-worker	1	1778823787354
019e2a28-f405-7995-997c-d60b0418f441	queue.job.started	default	{"jobId": "8", "attempt": 2, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823787525, "workspaceId": "default"}	019e2a28-f405-7995-997c-dd7861f36709	019e2a28-f405-7995-997c-e0214b13121c	\N	memory-worker	1	1778823787525
019e2a28-f5fd-7995-997d-19b610775b66	queue.job.started	default	{"jobId": "9", "attempt": 2, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823788029, "workspaceId": "default"}	019e2a28-f5fd-7995-997d-23ea4f30870a	019e2a28-f5fd-7995-997d-297741fb2738	\N	memory-worker	1	1778823788029
019e2a28-f790-7995-997d-6238302caf1c	queue.job.started	default	{"jobId": "10", "attempt": 2, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823788432, "workspaceId": "default"}	019e2a28-f790-7995-997d-6af65485ccf9	019e2a28-f790-7995-997d-7003671fcbb6	\N	memory-worker	1	1778823788432
019e2a28-f988-7995-997d-af7c283a3849	queue.job.started	default	{"jobId": "11", "attempt": 2, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823788936, "workspaceId": "default"}	019e2a28-f988-7995-997d-b119a52e5fd4	019e2a28-f988-7995-997d-bcef1bca9d25	\N	memory-worker	1	1778823788936
019e2a28-fb7f-7995-997d-f3869c49ffbb	queue.job.started	default	{"jobId": "12", "attempt": 2, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823789439, "workspaceId": "default"}	019e2a28-fb7f-7995-997d-fdb14515d10f	019e2a28-fb80-7995-997e-0549839d8a9f	\N	memory-worker	1	1778823789440
019e2a29-03c3-7995-997e-38bb7ef752aa	queue.job.started	default	{"jobId": "8", "attempt": 3, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823791555, "workspaceId": "default"}	019e2a29-03c3-7995-997e-404eb6efedba	019e2a29-03c3-7995-997e-4d5d2d2eeb7b	\N	memory-worker	1	1778823791555
019e2a29-05c1-7995-997e-8723a3e65d67	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "9", "jobName": "embed-memory", "attempts": 3, "workerId": "memory-worker-2976", "exhausted": true, "queueName": "memory", "timestamp": 1778823792065, "workspaceId": "default"}	019e2a29-05c1-7995-997e-8cd1e8f9c98e	019e2a29-05c1-7995-997e-93bbbeea15b8	\N	memory-worker	1	1778823792065
019e2a29-0945-7995-997e-c922cd2020ba	queue.job.started	default	{"jobId": "11", "attempt": 3, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823792965, "workspaceId": "default"}	019e2a29-0945-7995-997e-d10961adc73f	019e2a29-0945-7995-997e-db207994637c	\N	memory-worker	1	1778823792965
019e2a29-0b44-7995-997f-14b5f7690a36	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "12", "jobName": "embed-memory", "attempts": 3, "workerId": "memory-worker-2976", "exhausted": true, "queueName": "memory", "timestamp": 1778823793476, "workspaceId": "default"}	019e2a29-0b44-7995-997f-1c4162a60f12	019e2a29-0b44-7995-997f-22f4ffdbb81b	\N	memory-worker	1	1778823793476
019e2a28-edd4-7995-997b-e05032a1d422	queue.job.retry_scheduled	default	{"jobId": "9", "attempt": 2, "delayMs": 4000, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823785940, "workspaceId": "default"}	019e2a28-edd4-7995-997b-ece8b4407be4	019e2a28-edd4-7995-997b-f1c5a3370f44	\N	memory-worker	1	1778823785940
019e2a28-efbb-7995-997c-17edb5c53320	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "10", "jobName": "embed-memory", "attempts": 1, "workerId": "memory-worker-2976", "exhausted": false, "queueName": "memory", "timestamp": 1778823786427, "workspaceId": "default"}	019e2a28-efbb-7995-997c-1c6fa4b40dda	019e2a28-efbb-7995-997c-2409cfa5fbd7	\N	memory-worker	1	1778823786427
019e2a28-f19f-7995-997c-5e5d2d27b66a	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "11", "jobName": "embed-memory", "attempts": 1, "workerId": "memory-worker-2976", "exhausted": false, "queueName": "memory", "timestamp": 1778823786911, "workspaceId": "default"}	019e2a28-f19f-7995-997c-61efa1d0b22d	019e2a28-f19f-7995-997c-6eb241577e9c	\N	memory-worker	1	1778823786911
019e2a28-f361-7995-997c-a487cda2bce2	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "12", "jobName": "embed-memory", "attempts": 1, "workerId": "memory-worker-2976", "exhausted": false, "queueName": "memory", "timestamp": 1778823787361, "workspaceId": "default"}	019e2a28-f361-7995-997c-a83f90b19891	019e2a28-f361-7995-997c-b3e042093c8d	\N	memory-worker	1	1778823787361
019e2a28-f40c-7995-997c-eee41c7dd7c9	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "8", "jobName": "embed-memory", "attempts": 2, "workerId": "memory-worker-2976", "exhausted": false, "queueName": "memory", "timestamp": 1778823787532, "workspaceId": "default"}	019e2a28-f40c-7995-997c-f710277e507b	019e2a28-f40c-7995-997c-fb3472e5fbde	\N	memory-worker	1	1778823787532
019e2a28-f604-7995-997d-4fd25998dc97	queue.job.retry_scheduled	default	{"jobId": "9", "attempt": 3, "delayMs": 8000, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823788036, "workspaceId": "default"}	019e2a28-f604-7995-997d-564f426923f0	019e2a28-f604-7995-997d-5b910fee72cf	\N	memory-worker	1	1778823788036
019e2a28-f797-7995-997d-909defa1d42c	queue.job.retry_scheduled	default	{"jobId": "10", "attempt": 3, "delayMs": 8000, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823788439, "workspaceId": "default"}	019e2a28-f797-7995-997d-98ecbde148f2	019e2a28-f797-7995-997d-a6f41d043261	\N	memory-worker	1	1778823788439
019e2a28-f98f-7995-997d-df459ed858ad	queue.job.retry_scheduled	default	{"jobId": "11", "attempt": 3, "delayMs": 8000, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823788943, "workspaceId": "default"}	019e2a28-f98f-7995-997d-e4f451f627aa	019e2a28-f990-7995-997d-ebe5d3b5aac8	\N	memory-worker	1	1778823788944
019e2a28-fb87-7995-997e-2744935886e1	queue.job.retry_scheduled	default	{"jobId": "12", "attempt": 3, "delayMs": 8000, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823789447, "workspaceId": "default"}	019e2a28-fb87-7995-997e-2a291d2b21bd	019e2a28-fb87-7995-997e-3087de210d06	\N	memory-worker	1	1778823789447
019e2a29-05bb-7995-997e-6e35d45d3e79	queue.job.started	default	{"jobId": "9", "attempt": 3, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823792059, "workspaceId": "default"}	019e2a29-05bb-7995-997e-70be709b6b38	019e2a29-05bb-7995-997e-7bd37307c50e	\N	memory-worker	1	1778823792059
019e2a29-0751-7995-997e-b1fed7a563a9	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "10", "jobName": "embed-memory", "attempts": 3, "workerId": "memory-worker-2976", "exhausted": true, "queueName": "memory", "timestamp": 1778823792465, "workspaceId": "default"}	019e2a29-0751-7995-997e-bfd8fe0434a3	019e2a29-0751-7995-997e-c0739a34e3f8	\N	memory-worker	1	1778823792465
019e2a29-0b3c-7995-997e-fb043b1c85b0	queue.job.started	default	{"jobId": "12", "attempt": 3, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823793468, "workspaceId": "default"}	019e2a29-0b3c-7995-997f-070b0252359f	019e2a29-0b3c-7995-997f-09038af54e99	\N	memory-worker	1	1778823793468
019e2a28-edd4-7995-997b-c9e86b0d84e7	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "9", "jobName": "embed-memory", "attempts": 1, "workerId": "memory-worker-2976", "exhausted": false, "queueName": "memory", "timestamp": 1778823785940, "workspaceId": "default"}	019e2a28-edd4-7995-997b-d49bdb831742	019e2a28-edd4-7995-997b-d95b8e9d7db9	\N	memory-worker	1	1778823785940
019e2a28-efbb-7995-997c-2862fd264c4e	queue.job.retry_scheduled	default	{"jobId": "10", "attempt": 2, "delayMs": 4000, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823786427, "workspaceId": "default"}	019e2a28-efbb-7995-997c-341b1f279a1d	019e2a28-efbb-7995-997c-3e8769aebc15	\N	memory-worker	1	1778823786427
019e2a28-f19f-7995-997c-70b200848784	queue.job.retry_scheduled	default	{"jobId": "11", "attempt": 2, "delayMs": 4000, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823786911, "workspaceId": "default"}	019e2a28-f19f-7995-997c-7d8413fa2f35	019e2a28-f19f-7995-997c-84125f09602c	\N	memory-worker	1	1778823786911
019e2a28-f361-7995-997c-bb9fdccff234	queue.job.retry_scheduled	default	{"jobId": "12", "attempt": 2, "delayMs": 4000, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823787361, "workspaceId": "default"}	019e2a28-f362-7995-997c-c31575cca62d	019e2a28-f362-7995-997c-ca77330ebeb4	\N	memory-worker	1	1778823787362
019e2a28-f40c-7995-997d-0626e839af0f	queue.job.retry_scheduled	default	{"jobId": "8", "attempt": 3, "delayMs": 8000, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823787532, "workspaceId": "default"}	019e2a28-f40c-7995-997d-0acfd60686bd	019e2a28-f40c-7995-997d-10a6dcceb2d1	\N	memory-worker	1	1778823787532
019e2a28-f604-7995-997d-356694aa7037	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "9", "jobName": "embed-memory", "attempts": 2, "workerId": "memory-worker-2976", "exhausted": false, "queueName": "memory", "timestamp": 1778823788036, "workspaceId": "default"}	019e2a28-f604-7995-997d-38ea8b9ee5fd	019e2a28-f604-7995-997d-412fa9d87a97	\N	memory-worker	1	1778823788036
019e2a28-f797-7995-997d-78a543d4f3ab	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "10", "jobName": "embed-memory", "attempts": 2, "workerId": "memory-worker-2976", "exhausted": false, "queueName": "memory", "timestamp": 1778823788439, "workspaceId": "default"}	019e2a28-f797-7995-997d-86f5bdc5fb0c	019e2a28-f797-7995-997d-88eee054a950	\N	memory-worker	1	1778823788439
019e2a28-f98f-7995-997d-c658997d4726	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "11", "jobName": "embed-memory", "attempts": 2, "workerId": "memory-worker-2976", "exhausted": false, "queueName": "memory", "timestamp": 1778823788943, "workspaceId": "default"}	019e2a28-f98f-7995-997d-cb26b9c0121e	019e2a28-f98f-7995-997d-d7f229f6976f	\N	memory-worker	1	1778823788943
019e2a28-fb87-7995-997e-0d543cfadfd6	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "12", "jobName": "embed-memory", "attempts": 2, "workerId": "memory-worker-2976", "exhausted": false, "queueName": "memory", "timestamp": 1778823789447, "workspaceId": "default"}	019e2a28-fb87-7995-997e-15bcda7525a8	019e2a28-fb87-7995-997e-1d9c97eb1738	\N	memory-worker	1	1778823789447
019e2a29-03f3-7995-997e-54519394c12a	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "8", "jobName": "embed-memory", "attempts": 3, "workerId": "memory-worker-2976", "exhausted": true, "queueName": "memory", "timestamp": 1778823791603, "workspaceId": "default"}	019e2a29-03f3-7995-997e-5a696f9544af	019e2a29-03f4-7995-997e-63eecd5d9f42	\N	memory-worker	1	1778823791604
019e2a29-074c-7995-997e-9bef9d188094	queue.job.started	default	{"jobId": "10", "attempt": 3, "jobName": "embed-memory", "workerId": "memory-worker-2976", "queueName": "memory", "timestamp": 1778823792460, "workspaceId": "default"}	019e2a29-074c-7995-997e-a4c5c98edc73	019e2a29-074c-7995-997e-aad17aaf946d	\N	memory-worker	1	1778823792460
019e2a29-094c-7995-997e-e5a58fd04885	queue.job.failed	default	{"error": "All embedding providers failed.\\n  Ollama: fetch failed\\n  OpenAI: OPENAI_API_KEY not set", "jobId": "11", "jobName": "embed-memory", "attempts": 3, "workerId": "memory-worker-2976", "exhausted": true, "queueName": "memory", "timestamp": 1778823792972, "workspaceId": "default"}	019e2a29-094c-7995-997e-ec8e41dc3c71	019e2a29-094c-7995-997e-f5e5f241d77e	\N	memory-worker	1	1778823792972
019e2a28-efb2-71c1-92c5-d0ec755dd0e7	memory.created	default	{"tags": [], "type": "lesson", "memoryId": "019e2a28-efa9-725a-81ad-8967e621caf9", "workspaceId": "default"}	019e2a28-efb2-71c1-92c5-d7338f33cd51	019e2a28-efb2-71c1-92c5-db009abb6a42	\N	api	1	1778823786418
019e2a28-f197-73bb-a72b-f150489c96e8	memory.created	default	{"tags": [], "type": "goal", "memoryId": "019e2a28-f18f-77e7-a89a-723d028ac775", "workspaceId": "default"}	019e2a28-f197-73bb-a72b-f486d9624908	019e2a28-f197-73bb-a72b-f90d9ab94a19	\N	api	1	1778823786903
019e2a28-f358-722c-b39b-a5e60b3f50d7	memory.created	default	{"tags": [], "type": "idea", "memoryId": "019e2a28-f352-768b-9d75-7639343e050b", "workspaceId": "default"}	019e2a28-f358-722c-b39b-a89728134642	019e2a28-f358-722c-b39b-ae5df656624e	\N	api	1	1778823787352
019e2a28-f51c-74e0-ba1e-945a2336b97c	queue.job.started	default	{"jobId": "019e2a28-f513-722b-8084-7eae2052714e", "attempt": 1, "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823787804, "workspaceId": "default"}	019e2a28-f51c-74e0-ba1e-9a9b5aa93e5c	019e2a28-f51c-74e0-ba1e-9d6c45c0ca11	\N	briefing-worker	1	1778823787804
019e2a28-f53b-7579-8d0a-30fa90f935d1	queue.job.completed	default	{"jobId": "019e2a28-f513-722b-8084-7eae2052714e", "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823787835, "durationMs": 34, "workspaceId": "default"}	019e2a28-f53b-7579-8d0a-362268793b10	019e2a28-f53b-7579-8d0a-3826e41f356a	\N	briefing-worker	1	1778823787835
019e2a28-f6ee-710e-b64b-e2d6f755464d	briefing.generated	default	{"traceId": "019e2a28-f6bf-72c2-b853-939cc61da617", "sections": ["top_priorities", "risks", "opportunities", "next_actions"], "itemCount": 19, "timestamp": 1778823788270, "briefingId": "019e2a28-f6c9-758d-b32f-e3fd78d8e2ab", "durationMs": 37, "requestedBy": "user", "workspaceId": "default"}	019e2a28-f6ee-710e-b64b-e704d076462c	019e2a28-f6ee-710e-b64b-e88356d84a28	\N	briefing-worker	1	1778823788270
019e2a28-f8b5-771e-ae60-01b15159665e	queue.job.completed	default	{"jobId": "019e2a28-f892-75fd-ba5b-ec2068e86d81", "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823788725, "durationMs": 30, "workspaceId": "default"}	019e2a28-f8b5-771e-ae60-05041e6a1514	019e2a28-f8b5-771e-ae60-0abf027b42af	\N	briefing-worker	1	1778823788725
019e2a28-f537-7532-bf2a-7a65e9133365	briefing.generated	default	{"traceId": "019e2a28-f513-722b-8084-78f834a39239", "sections": ["top_priorities", "risks", "opportunities", "next_actions"], "itemCount": 19, "timestamp": 1778823787831, "briefingId": "019e2a28-f51d-71bb-912b-5f81c63b9f71", "durationMs": 26, "requestedBy": "user", "workspaceId": "default"}	019e2a28-f537-7532-bf2a-7de8b6f4dd94	019e2a28-f537-7532-bf2a-82b015689656	\N	briefing-worker	1	1778823787831
019e2a28-f89a-777a-b96f-aa2313bea114	queue.job.started	default	{"jobId": "019e2a28-f892-75fd-ba5b-ec2068e86d81", "attempt": 1, "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823788698, "workspaceId": "default"}	019e2a28-f89a-777a-b96f-ac993b018bd0	019e2a28-f89a-777a-b96f-b294bffe7823	\N	briefing-worker	1	1778823788698
019e2a28-f6c9-758d-b32f-d5e9c052aa68	queue.job.started	default	{"jobId": "019e2a28-f6bf-72c2-b853-97b307204df3", "attempt": 1, "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823788233, "workspaceId": "default"}	019e2a28-f6c9-758d-b32f-db474b0aef46	019e2a28-f6c9-758d-b32f-dfdf0ab16bc1	\N	briefing-worker	1	1778823788233
019e2a28-f6f4-77e9-bf2b-9486ea8480f2	queue.job.completed	default	{"jobId": "019e2a28-f6bf-72c2-b853-97b307204df3", "jobName": "generate-briefing", "workerId": "briefing-worker-16216", "queueName": "briefing", "timestamp": 1778823788276, "durationMs": 46, "workspaceId": "default"}	019e2a28-f6f4-77e9-bf2b-984704581b89	019e2a28-f6f4-77e9-bf2b-9eb7460952b3	\N	briefing-worker	1	1778823788276
019e2a28-f8b1-739c-85b1-5cd1dd6a08c5	briefing.generated	default	{"traceId": "019e2a28-f892-75fd-ba5b-eb660de55b99", "sections": ["top_priorities", "risks", "opportunities", "next_actions"], "itemCount": 19, "timestamp": 1778823788721, "briefingId": "019e2a28-f89b-753c-b466-baa697b94b20", "durationMs": 22, "requestedBy": "user", "workspaceId": "default"}	019e2a28-f8b1-739c-85b1-60b587f2c8f3	019e2a28-f8b1-739c-85b1-649ca4c6f6fb	\N	briefing-worker	1	1778823788721
019e2a2c-0a1c-71ac-b29f-7483350a5e01	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-b9e2-7329-a93c-659f7ab8f611/run", "method": "POST", "requestId": "req-40", "durationMs": 25, "statusCode": 202}	019e2a2c-0a1c-71ac-b29f-7871c3efc1b4	req-40	\N	audit-plugin	1	1778823989788
019e2a2c-0a1d-7179-a952-b1bbd313547e	queue.job.started	default	{"jobId": "019e2a2c-0a14-72bc-93b7-db0e9832a320", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-8500", "queueName": "workflow", "timestamp": 1778823989789, "workspaceId": "default"}	019e2a2c-0a1d-7179-a952-b1bbd313547e	019e2a2c-0a1d-7179-a952-b1bbd313547e	\N	workflow-worker	1	1778823989790
019e2a2c-0a41-706d-bb75-eefa99e00e9f	workflow.run.started	default	{"runId": "019e2a2c-0a14-72bc-93b7-db0e9832a320", "traceId": "019e2a2c-0a14-72bc-93b7-dd7d17623973"}	019e2a2c-0a41-706d-bb75-eefa99e00e9f	019e2a2c-0a41-706d-bb75-eefa99e00e9f	\N	workflow-worker	1	1778823989825
019e2a2c-0b98-749d-b33e-c88f78163caf	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-bb47-705a-8bbc-f0feeb2f3bfb/run", "method": "POST", "requestId": "req-41", "durationMs": 9, "statusCode": 202}	019e2a2c-0b98-749d-b33e-cda5034fb8aa	req-41	\N	audit-plugin	1	1778823990168
019e2a2c-0b9a-7758-bd97-9fbc75338ff4	queue.job.started	default	{"jobId": "019e2a2c-0b91-77b0-8550-e808491fb484", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-3316", "queueName": "workflow", "timestamp": 1778823990170, "workspaceId": "default"}	019e2a2c-0b9a-7758-bd97-9fbc75338ff4	019e2a2c-0b9a-7758-bd97-9fbc75338ff4	\N	workflow-worker	1	1778823990170
019e2a2c-0bc2-754b-bdc4-eecd70cae89c	workflow.run.started	default	{"runId": "019e2a2c-0b91-77b0-8550-e808491fb484", "traceId": "019e2a2c-0b91-77b0-8550-ef199b37d9c9"}	019e2a2c-0bc2-754b-bdc4-eecd70cae89c	019e2a2c-0bc2-754b-bdc4-eecd70cae89c	\N	workflow-worker	1	1778823990211
019e2a2c-0d26-7028-ac27-8b779b1d1641	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-bcad-772b-b156-20bb6d6a0328/run", "method": "POST", "requestId": "req-42", "durationMs": 11, "statusCode": 202}	019e2a2c-0d26-7028-ac27-8c25bba678bd	req-42	\N	audit-plugin	1	1778823990566
019e2a2c-0d27-772f-981f-366a32bedd82	queue.job.started	default	{"jobId": "019e2a2c-0d1e-7219-b020-6e619b701baf", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-8500", "queueName": "workflow", "timestamp": 1778823990567, "workspaceId": "default"}	019e2a2c-0d27-772f-981f-366a32bedd82	019e2a2c-0d27-772f-981f-366a32bedd82	\N	workflow-worker	1	1778823990567
019e2a2c-0d30-72cc-acb5-deb70b4bbf05	workflow.run.started	default	{"runId": "019e2a2c-0d1e-7219-b020-6e619b701baf", "traceId": "019e2a2c-0d1e-7219-b020-70ec11d66e58"}	019e2a2c-0d30-72cc-acb5-deb70b4bbf05	019e2a2c-0d30-72cc-acb5-deb70b4bbf05	\N	workflow-worker	1	1778823990576
019e2a2c-0e8f-71dc-9afa-9ad111bbe44f	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-be13-7188-8c61-86b20a9912d5/run", "method": "POST", "requestId": "req-43", "durationMs": 8, "statusCode": 202}	019e2a2c-0e8f-71dc-9afa-9d22764cd610	req-43	\N	audit-plugin	1	1778823990927
019e2a2c-0e90-745b-b2a0-621fcc8ee3c4	queue.job.started	default	{"jobId": "019e2a2c-0e88-725f-a375-d0c1033b7e02", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-3316", "queueName": "workflow", "timestamp": 1778823990928, "workspaceId": "default"}	019e2a2c-0e90-745b-b2a0-621fcc8ee3c4	019e2a2c-0e90-745b-b2a0-621fcc8ee3c4	\N	workflow-worker	1	1778823990928
019e2a2c-0e97-72c9-911b-c086976bf70a	workflow.run.started	default	{"runId": "019e2a2c-0e88-725f-a375-d0c1033b7e02", "traceId": "019e2a2c-0e88-725f-a375-d6a98359d140"}	019e2a2c-0e97-72c9-911b-c086976bf70a	019e2a2c-0e97-72c9-911b-c086976bf70a	\N	workflow-worker	1	1778823990935
019e2a2c-1029-77c3-b592-9536404908f2	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-bf91-717d-82f9-b529c3088dfe/run", "method": "POST", "requestId": "req-44", "durationMs": 11, "statusCode": 202}	019e2a2c-1029-77c3-b592-9984678d5c7d	req-44	\N	audit-plugin	1	1778823991337
019e2a2c-102a-722f-b51d-08567f73bbcc	queue.job.started	default	{"jobId": "019e2a2c-1022-7091-8bbd-2df084dd2aaa", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-8500", "queueName": "workflow", "timestamp": 1778823991338, "workspaceId": "default"}	019e2a2c-102a-722f-b51d-08567f73bbcc	019e2a2c-102a-722f-b51d-08567f73bbcc	\N	workflow-worker	1	1778823991338
019e2a2c-1031-7591-bd5b-8f3957e4652d	workflow.run.started	default	{"runId": "019e2a2c-1022-7091-8bbd-2df084dd2aaa", "traceId": "019e2a2c-1022-7091-8bbd-3186f9ca61e7"}	019e2a2c-1031-7591-bd5b-8f3957e4652d	019e2a2c-1031-7591-bd5b-8f3957e4652d	\N	workflow-worker	1	1778823991345
019e2a2c-11ab-735e-a0a8-e4c0606a8ea8	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-c102-7520-a5d9-ac2632a345a6/run", "method": "POST", "requestId": "req-45", "durationMs": 11, "statusCode": 202}	019e2a2c-11ab-735e-a0a8-ebf66f447eef	req-45	\N	audit-plugin	1	1778823991723
019e2a2c-11ad-7083-9b74-4d8a27e943df	queue.job.started	default	{"jobId": "019e2a2c-11a2-77d9-b232-03227413ab2d", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-3316", "queueName": "workflow", "timestamp": 1778823991725, "workspaceId": "default"}	019e2a2c-11ad-7083-9b74-4d8a27e943df	019e2a2c-11ad-7083-9b74-4d8a27e943df	\N	workflow-worker	1	1778823991725
019e2a2c-11b8-7734-9dea-2ca2e386a3e8	workflow.run.started	default	{"runId": "019e2a2c-11a2-77d9-b232-03227413ab2d", "traceId": "019e2a2c-11a2-77d9-b232-078b3add23ba"}	019e2a2c-11b8-7734-9dea-2ca2e386a3e8	019e2a2c-11b8-7734-9dea-2ca2e386a3e8	\N	workflow-worker	1	1778823991736
019e2a2c-130f-734b-95b6-6034b4a7900a	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-c274-71c0-9bf3-268e44d35639/run", "method": "POST", "requestId": "req-46", "durationMs": 10, "statusCode": 202}	019e2a2c-130f-734b-95b6-66740be01767	req-46	\N	audit-plugin	1	1778823992079
019e2a2c-1475-727f-9238-38b04c9002d5	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-c3fa-7446-aedb-25dbcb892a9d/run", "method": "POST", "requestId": "req-47", "durationMs": 11, "statusCode": 202}	019e2a2c-1475-727f-9238-3c7cf89bfe9c	req-47	\N	audit-plugin	1	1778823992437
019e2a2c-15f6-752b-a831-4a36c7e75cba	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-c56a-70e9-85ea-7b99dd6a1be9/run", "method": "POST", "requestId": "req-48", "durationMs": 12, "statusCode": 202}	019e2a2c-15f6-752b-a831-4e0db406a61d	req-48	\N	audit-plugin	1	1778823992822
019e2a2c-176f-71f2-9309-c2d01a899eec	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-c6ec-72eb-a1a3-96a31c05aeb4/run", "method": "POST", "requestId": "req-49", "durationMs": 12, "statusCode": 202}	019e2a2c-176f-71f2-9309-c764297fa326	req-49	\N	audit-plugin	1	1778823993199
019e2a2c-130f-7782-989a-3bed7818baa7	queue.job.started	default	{"jobId": "019e2a2c-1308-710a-a349-dc3e482b7aee", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-8500", "queueName": "workflow", "timestamp": 1778823992079, "workspaceId": "default"}	019e2a2c-130f-7782-989a-3bed7818baa7	019e2a2c-130f-7782-989a-3bed7818baa7	\N	workflow-worker	1	1778823992079
019e2a2c-1316-731d-b0a0-fc7828c8872c	workflow.run.started	default	{"runId": "019e2a2c-1308-710a-a349-dc3e482b7aee", "traceId": "019e2a2c-1308-710a-a349-e2ffebeec275"}	019e2a2c-1316-731d-b0a0-fc7828c8872c	019e2a2c-1316-731d-b0a0-fc7828c8872c	\N	workflow-worker	1	1778823992086
019e2a2c-15f7-71da-a1d6-3e84b349e55e	queue.job.started	default	{"jobId": "019e2a2c-15ed-700f-ad86-93cbb396bb5b", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-8500", "queueName": "workflow", "timestamp": 1778823992823, "workspaceId": "default"}	019e2a2c-15f7-71da-a1d6-3e84b349e55e	019e2a2c-15f7-71da-a1d6-3e84b349e55e	\N	workflow-worker	1	1778823992823
019e2a2c-2285-76d1-8c7d-2c034dea7585	queue.job.completed	default	{"jobId": "019e2a2c-0a14-72bc-93b7-db0e9832a320", "jobName": "execute-workflow", "workerId": "workflow-worker-8500", "queueName": "workflow", "timestamp": 1778823996037, "durationMs": 6251, "workspaceId": "default"}	019e2a2c-2285-76d1-8c7d-2c034dea7585	019e2a2c-2285-76d1-8c7d-2c034dea7585	\N	workflow-worker	1	1778823996037
019e2a2c-250c-7618-89ee-2d4e7c25dc43	queue.job.completed	default	{"jobId": "019e2a2c-0d1e-7219-b020-6e619b701baf", "jobName": "execute-workflow", "workerId": "workflow-worker-8500", "queueName": "workflow", "timestamp": 1778823996684, "durationMs": 6119, "workspaceId": "default"}	019e2a2c-250c-7618-89ee-2d4e7c25dc43	019e2a2c-250c-7618-89ee-2d4e7c25dc43	\N	workflow-worker	1	1778823996684
019e2a2c-27f3-753f-b50a-efa8160ff5a6	queue.job.completed	default	{"jobId": "019e2a2c-1022-7091-8bbd-2df084dd2aaa", "jobName": "execute-workflow", "workerId": "workflow-worker-8500", "queueName": "workflow", "timestamp": 1778823997427, "durationMs": 6091, "workspaceId": "default"}	019e2a2c-27f3-753f-b50a-efa8160ff5a6	019e2a2c-27f3-753f-b50a-efa8160ff5a6	\N	workflow-worker	1	1778823997427
019e2a2c-2aec-71ae-8296-49aba44bd238	queue.job.completed	default	{"jobId": "019e2a2c-1308-710a-a349-dc3e482b7aee", "jobName": "execute-workflow", "workerId": "workflow-worker-8500", "queueName": "workflow", "timestamp": 1778823998188, "durationMs": 6110, "workspaceId": "default"}	019e2a2c-2aec-71ae-8296-49aba44bd238	019e2a2c-2aec-71ae-8296-49aba44bd238	\N	workflow-worker	1	1778823998188
019e2a2c-1476-713c-8f22-5f2230239e2e	queue.job.started	default	{"jobId": "019e2a2c-146d-7148-a9b2-8a7cb4aef396", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-3316", "queueName": "workflow", "timestamp": 1778823992438, "workspaceId": "default"}	019e2a2c-1476-713c-8f22-5f2230239e2e	019e2a2c-1476-713c-8f22-5f2230239e2e	\N	workflow-worker	1	1778823992438
019e2a2c-1779-7179-9708-481d8f527c62	workflow.run.started	default	{"runId": "019e2a2c-1766-711c-ba86-f012b9ed7d03", "traceId": "019e2a2c-1766-711c-ba86-f58d40675229"}	019e2a2c-1779-7179-9708-481d8f527c62	019e2a2c-1779-7179-9708-481d8f527c62	\N	workflow-worker	1	1778823993209
019e2a2c-23c7-72e0-8c46-e6665f50d027	workflow.step.failed	default	{"error": "HTTP request failed: fetch failed", "runId": "019e2a2c-0b91-77b0-8550-e808491fb484", "stepId": "s1", "traceId": "019e2a2c-0b91-77b0-8550-ef199b37d9c9"}	019e2a2c-23c7-72e0-8c46-e6665f50d027	019e2a2c-23c7-72e0-8c46-e6665f50d027	\N	workflow-worker	1	1778823996359
019e2a2c-23d7-74f3-b8b3-dc99c3270385	workflow.run.failed	default	{"runId": "019e2a2c-0b91-77b0-8550-e808491fb484", "reason": "Step s1 failed: HTTP request failed: fetch failed", "traceId": "019e2a2c-0b91-77b0-8550-ef199b37d9c9"}	019e2a2c-23d7-74f3-b8b3-dc99c3270385	019e2a2c-23d7-74f3-b8b3-dc99c3270385	\N	workflow-worker	1	1778823996375
019e2a2c-2656-77fb-8845-c4344bbb5e0c	workflow.step.failed	default	{"error": "HTTP request failed: fetch failed", "runId": "019e2a2c-0e88-725f-a375-d0c1033b7e02", "stepId": "s1", "traceId": "019e2a2c-0e88-725f-a375-d6a98359d140"}	019e2a2c-2656-77fb-8845-c4344bbb5e0c	019e2a2c-2656-77fb-8845-c4344bbb5e0c	\N	workflow-worker	1	1778823997014
019e2a2c-265c-77f0-b407-acefddfb2282	workflow.run.failed	default	{"runId": "019e2a2c-0e88-725f-a375-d0c1033b7e02", "reason": "Step s1 failed: HTTP request failed: fetch failed", "traceId": "019e2a2c-0e88-725f-a375-d6a98359d140"}	019e2a2c-265c-77f0-b407-acefddfb2282	019e2a2c-265c-77f0-b407-acefddfb2282	\N	workflow-worker	1	1778823997020
019e2a2c-2980-7601-b572-2a23d0b04264	workflow.step.failed	default	{"error": "HTTP request failed: fetch failed", "runId": "019e2a2c-11a2-77d9-b232-03227413ab2d", "stepId": "s1", "traceId": "019e2a2c-11a2-77d9-b232-078b3add23ba"}	019e2a2c-2980-7601-b572-2a23d0b04264	019e2a2c-2980-7601-b572-2a23d0b04264	\N	workflow-worker	1	1778823997824
019e2a2c-2986-77b5-b7c7-33c915476589	workflow.run.failed	default	{"runId": "019e2a2c-11a2-77d9-b232-03227413ab2d", "reason": "Step s1 failed: HTTP request failed: fetch failed", "traceId": "019e2a2c-11a2-77d9-b232-078b3add23ba"}	019e2a2c-2986-77b5-b7c7-33c915476589	019e2a2c-2986-77b5-b7c7-33c915476589	\N	workflow-worker	1	1778823997830
019e2a2c-2c46-738e-a62a-50e136e84f87	workflow.step.failed	default	{"error": "HTTP request failed: fetch failed", "runId": "019e2a2c-146d-7148-a9b2-8a7cb4aef396", "stepId": "s1", "traceId": "019e2a2c-146d-7148-a9b2-8d6e837db21c"}	019e2a2c-2c46-738e-a62a-50e136e84f87	019e2a2c-2c46-738e-a62a-50e136e84f87	\N	workflow-worker	1	1778823998534
019e2a2c-2c4c-7204-8996-9a8605742817	workflow.run.failed	default	{"runId": "019e2a2c-146d-7148-a9b2-8a7cb4aef396", "reason": "Step s1 failed: HTTP request failed: fetch failed", "traceId": "019e2a2c-146d-7148-a9b2-8d6e837db21c"}	019e2a2c-2c4c-7204-8996-9a8605742817	019e2a2c-2c4c-7204-8996-9a8605742817	\N	workflow-worker	1	1778823998540
019e2a2c-147e-7705-a39c-7cf89ecb708c	workflow.run.started	default	{"runId": "019e2a2c-146d-7148-a9b2-8a7cb4aef396", "traceId": "019e2a2c-146d-7148-a9b2-8d6e837db21c"}	019e2a2c-147e-7705-a39c-7cf89ecb708c	019e2a2c-147e-7705-a39c-7cf89ecb708c	\N	workflow-worker	1	1778823992446
019e2a2c-1771-74ce-b67e-b83da1153033	queue.job.started	default	{"jobId": "019e2a2c-1766-711c-ba86-f012b9ed7d03", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-3316", "queueName": "workflow", "timestamp": 1778823993200, "workspaceId": "default"}	019e2a2c-1771-74ce-b67e-b83da1153033	019e2a2c-1771-74ce-b67e-b83da1153033	\N	workflow-worker	1	1778823993201
019e2a2c-2412-739a-a1c9-804a077305c7	queue.job.completed	default	{"jobId": "019e2a2c-0b91-77b0-8550-e808491fb484", "jobName": "execute-workflow", "workerId": "workflow-worker-3316", "queueName": "workflow", "timestamp": 1778823996434, "durationMs": 6267, "workspaceId": "default"}	019e2a2c-2412-739a-a1c9-804a077305c7	019e2a2c-2412-739a-a1c9-804a077305c7	\N	workflow-worker	1	1778823996434
019e2a2c-2669-71ff-a766-eb1be22a4510	queue.job.completed	default	{"jobId": "019e2a2c-0e88-725f-a375-d0c1033b7e02", "jobName": "execute-workflow", "workerId": "workflow-worker-3316", "queueName": "workflow", "timestamp": 1778823997033, "durationMs": 6108, "workspaceId": "default"}	019e2a2c-2669-71ff-a766-eb1be22a4510	019e2a2c-2669-71ff-a766-eb1be22a4510	\N	workflow-worker	1	1778823997033
019e2a2c-2992-767b-b55f-0a058503f513	queue.job.completed	default	{"jobId": "019e2a2c-11a2-77d9-b232-03227413ab2d", "jobName": "execute-workflow", "workerId": "workflow-worker-3316", "queueName": "workflow", "timestamp": 1778823997842, "durationMs": 6121, "workspaceId": "default"}	019e2a2c-2992-767b-b55f-0a058503f513	019e2a2c-2992-767b-b55f-0a058503f513	\N	workflow-worker	1	1778823997842
019e2a2c-2c58-771b-a26d-f5f148258386	queue.job.completed	default	{"jobId": "019e2a2c-146d-7148-a9b2-8a7cb4aef396", "jobName": "execute-workflow", "workerId": "workflow-worker-3316", "queueName": "workflow", "timestamp": 1778823998552, "durationMs": 6116, "workspaceId": "default"}	019e2a2c-2c58-771b-a26d-f5f148258386	019e2a2c-2c58-771b-a26d-f5f148258386	\N	workflow-worker	1	1778823998552
019e2a2c-1601-71cf-83a3-ccd7e8fe776d	workflow.run.started	default	{"runId": "019e2a2c-15ed-700f-ad86-93cbb396bb5b", "traceId": "019e2a2c-15ed-700f-ad86-94cb71e730b7"}	019e2a2c-1601-71cf-83a3-ccd7e8fe776d	019e2a2c-1601-71cf-83a3-ccd7e8fe776d	\N	workflow-worker	1	1778823992833
019e2a2c-223d-765c-ae55-cccba204077e	workflow.step.failed	default	{"error": "HTTP request failed: fetch failed", "runId": "019e2a2c-0a14-72bc-93b7-db0e9832a320", "stepId": "s1", "traceId": "019e2a2c-0a14-72bc-93b7-dd7d17623973"}	019e2a2c-223d-765c-ae55-cccba204077e	019e2a2c-223d-765c-ae55-cccba204077e	\N	workflow-worker	1	1778823995965
019e2a2c-224c-763c-aef8-b488d3df19a6	workflow.run.failed	default	{"runId": "019e2a2c-0a14-72bc-93b7-db0e9832a320", "reason": "Step s1 failed: HTTP request failed: fetch failed", "traceId": "019e2a2c-0a14-72bc-93b7-dd7d17623973"}	019e2a2c-224c-763c-aef8-b488d3df19a6	019e2a2c-224c-763c-aef8-b488d3df19a6	\N	workflow-worker	1	1778823995980
019e2a2c-2254-7662-9bf3-73a545f1ad36	observability.failure.linked	default	{"runId": "019e2a2c-0a14-72bc-93b7-db0e9832a320", "failureId": "019e2a2c-2250-772e-ab41-13fc2cc75ca5", "rootCause": "Step s1 failed: HTTP request failed: fetch failed", "timestamp": 1778823995984, "linkedEventIds": ["019e2a2c-2250-772e-ab41-0d605dd561d2"]}	019e2a2c-0a14-72bc-93b7-dd7d17623973	019e2a2c-0a14-72bc-93b7-dd7d17623973	\N	observability-service	1	1778823995988
019e2a2c-23e0-72ec-a84a-85c3106ddba8	observability.failure.linked	default	{"runId": "019e2a2c-0b91-77b0-8550-e808491fb484", "failureId": "019e2a2c-23db-7654-99a9-6082b1c174e6", "rootCause": "Step s1 failed: HTTP request failed: fetch failed", "timestamp": 1778823996379, "linkedEventIds": ["019e2a2c-23db-7654-99a9-5ca642b54dd3"]}	019e2a2c-0b91-77b0-8550-ef199b37d9c9	019e2a2c-0b91-77b0-8550-ef199b37d9c9	\N	observability-service	1	1778823996384
019e2a2c-24f8-767b-b92e-fc204213f1fa	workflow.step.failed	default	{"error": "HTTP request failed: fetch failed", "runId": "019e2a2c-0d1e-7219-b020-6e619b701baf", "stepId": "s1", "traceId": "019e2a2c-0d1e-7219-b020-70ec11d66e58"}	019e2a2c-24f8-767b-b92e-fc204213f1fa	019e2a2c-24f8-767b-b92e-fc204213f1fa	\N	workflow-worker	1	1778823996664
019e2a2c-24ff-77b2-a46a-f22228445593	workflow.run.failed	default	{"runId": "019e2a2c-0d1e-7219-b020-6e619b701baf", "reason": "Step s1 failed: HTTP request failed: fetch failed", "traceId": "019e2a2c-0d1e-7219-b020-70ec11d66e58"}	019e2a2c-24ff-77b2-a46a-f22228445593	019e2a2c-24ff-77b2-a46a-f22228445593	\N	workflow-worker	1	1778823996671
019e2a2c-2505-74b8-99ac-6ec0d2fff75b	observability.failure.linked	default	{"runId": "019e2a2c-0d1e-7219-b020-6e619b701baf", "failureId": "019e2a2c-2502-730a-8d8d-4f7b71335437", "rootCause": "Step s1 failed: HTTP request failed: fetch failed", "timestamp": 1778823996674, "linkedEventIds": ["019e2a2c-2502-730a-8d8d-4a674aaa9023"]}	019e2a2c-0d1e-7219-b020-70ec11d66e58	019e2a2c-0d1e-7219-b020-70ec11d66e58	\N	observability-service	1	1778823996677
019e2a2c-2662-76df-945a-15d950402970	observability.failure.linked	default	{"runId": "019e2a2c-0e88-725f-a375-d0c1033b7e02", "failureId": "019e2a2c-265f-761b-a91d-f7fc6297cc3a", "rootCause": "Step s1 failed: HTTP request failed: fetch failed", "timestamp": 1778823997023, "linkedEventIds": ["019e2a2c-265f-761b-a91d-f0a494296fbe"]}	019e2a2c-0e88-725f-a375-d6a98359d140	019e2a2c-0e88-725f-a375-d6a98359d140	\N	observability-service	1	1778823997026
019e2a2c-27e1-766d-beec-ec81a3b4a31e	workflow.step.failed	default	{"error": "HTTP request failed: fetch failed", "runId": "019e2a2c-1022-7091-8bbd-2df084dd2aaa", "stepId": "s1", "traceId": "019e2a2c-1022-7091-8bbd-3186f9ca61e7"}	019e2a2c-27e1-766d-beec-ec81a3b4a31e	019e2a2c-27e1-766d-beec-ec81a3b4a31e	\N	workflow-worker	1	1778823997409
019e2a2c-27e7-77fa-b968-d37ae36f9887	workflow.run.failed	default	{"runId": "019e2a2c-1022-7091-8bbd-2df084dd2aaa", "reason": "Step s1 failed: HTTP request failed: fetch failed", "traceId": "019e2a2c-1022-7091-8bbd-3186f9ca61e7"}	019e2a2c-27e7-77fa-b968-d37ae36f9887	019e2a2c-27e7-77fa-b968-d37ae36f9887	\N	workflow-worker	1	1778823997415
019e2a2c-27ec-77c7-85aa-d23a377378b7	observability.failure.linked	default	{"runId": "019e2a2c-1022-7091-8bbd-2df084dd2aaa", "failureId": "019e2a2c-27e9-752e-86e1-c8d42f2c79cb", "rootCause": "Step s1 failed: HTTP request failed: fetch failed", "timestamp": 1778823997417, "linkedEventIds": ["019e2a2c-27e9-752e-86e1-c71b0c83a69f"]}	019e2a2c-1022-7091-8bbd-3186f9ca61e7	019e2a2c-1022-7091-8bbd-3186f9ca61e7	\N	observability-service	1	1778823997420
019e2a2c-298b-72d4-8898-6b737cfb5a3e	observability.failure.linked	default	{"runId": "019e2a2c-11a2-77d9-b232-03227413ab2d", "failureId": "019e2a2c-2988-76b8-a770-ad5ff8c8be97", "rootCause": "Step s1 failed: HTTP request failed: fetch failed", "timestamp": 1778823997832, "linkedEventIds": ["019e2a2c-2988-76b8-a770-aa80e7f4bb94"]}	019e2a2c-11a2-77d9-b232-078b3add23ba	019e2a2c-11a2-77d9-b232-078b3add23ba	\N	observability-service	1	1778823997835
019e2a2c-2ad9-75ed-b7f8-c2fe02c74b78	workflow.step.failed	default	{"error": "HTTP request failed: fetch failed", "runId": "019e2a2c-1308-710a-a349-dc3e482b7aee", "stepId": "s1", "traceId": "019e2a2c-1308-710a-a349-e2ffebeec275"}	019e2a2c-2ad9-75ed-b7f8-c2fe02c74b78	019e2a2c-2ad9-75ed-b7f8-c2fe02c74b78	\N	workflow-worker	1	1778823998169
019e2a2c-2adf-7059-b64c-01b10fefc5b7	workflow.run.failed	default	{"runId": "019e2a2c-1308-710a-a349-dc3e482b7aee", "reason": "Step s1 failed: HTTP request failed: fetch failed", "traceId": "019e2a2c-1308-710a-a349-e2ffebeec275"}	019e2a2c-2adf-7059-b64c-01b10fefc5b7	019e2a2c-2adf-7059-b64c-01b10fefc5b7	\N	workflow-worker	1	1778823998175
019e2a2c-2ae4-770e-9268-a8d0eb7611c6	observability.failure.linked	default	{"runId": "019e2a2c-1308-710a-a349-dc3e482b7aee", "failureId": "019e2a2c-2ae1-738d-8d8c-3fb3f72b7693", "rootCause": "Step s1 failed: HTTP request failed: fetch failed", "timestamp": 1778823998177, "linkedEventIds": ["019e2a2c-2ae1-738d-8d8c-3972618b2d38"]}	019e2a2c-1308-710a-a349-e2ffebeec275	019e2a2c-1308-710a-a349-e2ffebeec275	\N	observability-service	1	1778823998180
019e2a2c-2c51-7276-b898-6ae596058037	observability.failure.linked	default	{"runId": "019e2a2c-146d-7148-a9b2-8a7cb4aef396", "failureId": "019e2a2c-2c4f-7732-a43b-e4f4dc954a0b", "rootCause": "Step s1 failed: HTTP request failed: fetch failed", "timestamp": 1778823998543, "linkedEventIds": ["019e2a2c-2c4f-7732-a43b-e0ea82556b42"]}	019e2a2c-146d-7148-a9b2-8d6e837db21c	019e2a2c-146d-7148-a9b2-8d6e837db21c	\N	observability-service	1	1778823998545
019e2a2c-2dc6-706e-852a-a47595d35073	workflow.step.failed	default	{"error": "HTTP request failed: fetch failed", "runId": "019e2a2c-15ed-700f-ad86-93cbb396bb5b", "stepId": "s1", "traceId": "019e2a2c-15ed-700f-ad86-94cb71e730b7"}	019e2a2c-2dc6-706e-852a-a47595d35073	019e2a2c-2dc6-706e-852a-a47595d35073	\N	workflow-worker	1	1778823998918
019e2a2c-2dcc-758d-ba25-e427f0880251	workflow.run.failed	default	{"runId": "019e2a2c-15ed-700f-ad86-93cbb396bb5b", "reason": "Step s1 failed: HTTP request failed: fetch failed", "traceId": "019e2a2c-15ed-700f-ad86-94cb71e730b7"}	019e2a2c-2dcc-758d-ba25-e427f0880251	019e2a2c-2dcc-758d-ba25-e427f0880251	\N	workflow-worker	1	1778823998924
019e2a2c-2dd2-73c8-b06c-56b3493209d5	observability.failure.linked	default	{"runId": "019e2a2c-15ed-700f-ad86-93cbb396bb5b", "failureId": "019e2a2c-2dcf-75dc-87b1-34b848a086f0", "rootCause": "Step s1 failed: HTTP request failed: fetch failed", "timestamp": 1778823998927, "linkedEventIds": ["019e2a2c-2dcf-75dc-87b1-33b46db7c6a4"]}	019e2a2c-15ed-700f-ad86-94cb71e730b7	019e2a2c-15ed-700f-ad86-94cb71e730b7	\N	observability-service	1	1778823998930
019e2a2c-2dd8-739c-8a8e-d99d9de19109	queue.job.completed	default	{"jobId": "019e2a2c-15ed-700f-ad86-93cbb396bb5b", "jobName": "execute-workflow", "workerId": "workflow-worker-8500", "queueName": "workflow", "timestamp": 1778823998936, "durationMs": 6116, "workspaceId": "default"}	019e2a2c-2dd8-739c-8a8e-d99d9de19109	019e2a2c-2dd8-739c-8a8e-d99d9de19109	\N	workflow-worker	1	1778823998936
019e2a2c-2f35-716b-9244-845abfd06db6	workflow.step.failed	default	{"error": "HTTP request failed: fetch failed", "runId": "019e2a2c-1766-711c-ba86-f012b9ed7d03", "stepId": "s1", "traceId": "019e2a2c-1766-711c-ba86-f58d40675229"}	019e2a2c-2f35-716b-9244-845abfd06db6	019e2a2c-2f35-716b-9244-845abfd06db6	\N	workflow-worker	1	1778823999285
019e2a2c-2f3c-74fc-aef9-da51f8a30401	workflow.run.failed	default	{"runId": "019e2a2c-1766-711c-ba86-f012b9ed7d03", "reason": "Step s1 failed: HTTP request failed: fetch failed", "traceId": "019e2a2c-1766-711c-ba86-f58d40675229"}	019e2a2c-2f3c-74fc-aef9-da51f8a30401	019e2a2c-2f3c-74fc-aef9-da51f8a30401	\N	workflow-worker	1	1778823999292
019e2a2c-2f42-70ee-bce2-540f307a87c4	observability.failure.linked	default	{"runId": "019e2a2c-1766-711c-ba86-f012b9ed7d03", "failureId": "019e2a2c-2f3f-742f-8da6-1d252eee3705", "rootCause": "Step s1 failed: HTTP request failed: fetch failed", "timestamp": 1778823999295, "linkedEventIds": ["019e2a2c-2f3e-71c8-8a47-6a394ccd6993"]}	019e2a2c-1766-711c-ba86-f58d40675229	019e2a2c-1766-711c-ba86-f58d40675229	\N	observability-service	1	1778823999298
019e2a2c-2f49-75e6-b08d-a82c0a39dd0c	queue.job.completed	default	{"jobId": "019e2a2c-1766-711c-ba86-f012b9ed7d03", "jobName": "execute-workflow", "workerId": "workflow-worker-3316", "queueName": "workflow", "timestamp": 1778823999305, "durationMs": 6108, "workspaceId": "default"}	019e2a2c-2f49-75e6-b08d-a82c0a39dd0c	019e2a2c-2f49-75e6-b08d-a82c0a39dd0c	\N	workflow-worker	1	1778823999305
019e2a2e-e23b-747a-88e0-48f66841e928	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-c102-7520-a5d9-ac2632a345a6/run", "method": "POST", "requestId": "req-4q", "durationMs": 51, "statusCode": 202}	019e2a2e-e23b-747a-88e0-4c272e4ce89d	req-4q	\N	audit-plugin	1	1778824176187
019e2a2e-e23e-743e-bc70-f2374ec2b1e8	queue.job.started	default	{"jobId": "019e2a2e-e229-771b-8a5a-f6e0140daf90", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-13236", "queueName": "workflow", "timestamp": 1778824176190, "workspaceId": "default"}	019e2a2e-e23e-743e-bc70-f2374ec2b1e8	019e2a2e-e23e-743e-bc70-f2374ec2b1e8	\N	workflow-worker	1	1778824176191
019e2a2e-e26e-7749-ac65-ec725c5f3ac5	workflow.run.started	default	{"runId": "019e2a2e-e229-771b-8a5a-f6e0140daf90", "traceId": "019e2a2e-e22a-75d9-8934-8b2f4f063032"}	019e2a2e-e26e-7749-ac65-ec725c5f3ac5	019e2a2e-e26e-7749-ac65-ec725c5f3ac5	\N	workflow-worker	1	1778824176238
019e2a2e-e3d4-70ed-a367-e8acef321884	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-c274-71c0-9bf3-268e44d35639/run", "method": "POST", "requestId": "req-4r", "durationMs": 12, "statusCode": 202}	019e2a2e-e3d4-70ed-a367-ec036db6488c	req-4r	\N	audit-plugin	1	1778824176596
019e2a2e-e3d6-7636-b65c-3de6517be70a	queue.job.started	default	{"jobId": "019e2a2e-e3cc-772e-a956-dca340326f4e", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-11984", "queueName": "workflow", "timestamp": 1778824176598, "workspaceId": "default"}	019e2a2e-e3d6-7636-b65c-3de6517be70a	019e2a2e-e3d6-7636-b65c-3de6517be70a	\N	workflow-worker	1	1778824176598
019e2a2e-e3fe-7789-bc2f-5c345af26a32	workflow.run.started	default	{"runId": "019e2a2e-e3cc-772e-a956-dca340326f4e", "traceId": "019e2a2e-e3cc-772e-a956-e2ba924719bb"}	019e2a2e-e3fe-7789-bc2f-5c345af26a32	019e2a2e-e3fe-7789-bc2f-5c345af26a32	\N	workflow-worker	1	1778824176638
019e2a2e-e53f-7391-a6b8-a6f47b93554a	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-c3fa-7446-aedb-25dbcb892a9d/run", "method": "POST", "requestId": "req-4s", "durationMs": 8, "statusCode": 202}	019e2a2e-e53f-7391-a6b8-aa8678050a65	req-4s	\N	audit-plugin	1	1778824176959
019e2a2e-e540-757b-9d63-a14251a2fbb6	queue.job.started	default	{"jobId": "019e2a2e-e538-71ad-ac4c-cd60944b1a66", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-13236", "queueName": "workflow", "timestamp": 1778824176960, "workspaceId": "default"}	019e2a2e-e540-757b-9d63-a14251a2fbb6	019e2a2e-e540-757b-9d63-a14251a2fbb6	\N	workflow-worker	1	1778824176960
019e2a2e-e548-7229-8cf0-7daa3811cad2	workflow.run.started	default	{"runId": "019e2a2e-e538-71ad-ac4c-cd60944b1a66", "traceId": "019e2a2e-e538-71ad-ac4c-d27e3caf9d21"}	019e2a2e-e548-7229-8cf0-7daa3811cad2	019e2a2e-e548-7229-8cf0-7daa3811cad2	\N	workflow-worker	1	1778824176968
019e2a2e-fa70-7340-8055-f72ebfc985ea	workflow.step.failed	default	{"error": "HTTP request failed: fetch failed", "runId": "019e2a2e-e229-771b-8a5a-f6e0140daf90", "stepId": "s1", "traceId": "019e2a2e-e22a-75d9-8934-8b2f4f063032"}	019e2a2e-fa70-7340-8055-f72ebfc985ea	019e2a2e-fa70-7340-8055-f72ebfc985ea	\N	workflow-worker	1	1778824182384
019e2a2e-fa77-77ea-ba1e-012209945709	workflow.run.failed	default	{"runId": "019e2a2e-e229-771b-8a5a-f6e0140daf90", "reason": "Step s1 failed: HTTP request failed: fetch failed", "traceId": "019e2a2e-e22a-75d9-8934-8b2f4f063032"}	019e2a2e-fa77-77ea-ba1e-012209945709	019e2a2e-fa77-77ea-ba1e-012209945709	\N	workflow-worker	1	1778824182391
019e2a2e-fa81-746e-8f37-a69be71cef2a	observability.failure.linked	default	{"runId": "019e2a2e-e229-771b-8a5a-f6e0140daf90", "failureId": "019e2a2e-fa7e-7292-ab11-3cebdb18ec95", "rootCause": "Step s1 failed: HTTP request failed: fetch failed", "timestamp": 1778824182398, "linkedEventIds": ["019e2a2e-fa7e-7292-ab11-3851ea89da6d"]}	019e2a2e-e22a-75d9-8934-8b2f4f063032	019e2a2e-e22a-75d9-8934-8b2f4f063032	\N	observability-service	1	1778824182401
019e2a2e-fab6-71d9-bd99-a69e7a59d27c	queue.job.completed	default	{"jobId": "019e2a2e-e229-771b-8a5a-f6e0140daf90", "jobName": "execute-workflow", "workerId": "workflow-worker-13236", "queueName": "workflow", "timestamp": 1778824182454, "durationMs": 6269, "workspaceId": "default"}	019e2a2e-fab6-71d9-bd99-a69e7a59d27c	019e2a2e-fab6-71d9-bd99-a69e7a59d27c	\N	workflow-worker	1	1778824182454
019e2a2e-fbfe-727a-868e-a62cab4fd5d2	workflow.step.failed	default	{"error": "HTTP request failed: fetch failed", "runId": "019e2a2e-e3cc-772e-a956-dca340326f4e", "stepId": "s1", "traceId": "019e2a2e-e3cc-772e-a956-e2ba924719bb"}	019e2a2e-fbfe-727a-868e-a62cab4fd5d2	019e2a2e-fbfe-727a-868e-a62cab4fd5d2	\N	workflow-worker	1	1778824182782
019e2a2e-fc08-71cd-9e1f-b36a34f4f7c8	workflow.run.failed	default	{"runId": "019e2a2e-e3cc-772e-a956-dca340326f4e", "reason": "Step s1 failed: HTTP request failed: fetch failed", "traceId": "019e2a2e-e3cc-772e-a956-e2ba924719bb"}	019e2a2e-fc08-71cd-9e1f-b36a34f4f7c8	019e2a2e-fc08-71cd-9e1f-b36a34f4f7c8	\N	workflow-worker	1	1778824182792
019e2a2e-fc12-70d8-9a50-10a4876acc45	observability.failure.linked	default	{"runId": "019e2a2e-e3cc-772e-a956-dca340326f4e", "failureId": "019e2a2e-fc0e-756b-9086-f41375e32a1f", "rootCause": "Step s1 failed: HTTP request failed: fetch failed", "timestamp": 1778824182798, "linkedEventIds": ["019e2a2e-fc0e-756b-9086-f270b918cca5"]}	019e2a2e-e3cc-772e-a956-e2ba924719bb	019e2a2e-e3cc-772e-a956-e2ba924719bb	\N	observability-service	1	1778824182802
019e2a2e-fc46-74bb-849d-226b18facfc6	queue.job.completed	default	{"jobId": "019e2a2e-e3cc-772e-a956-dca340326f4e", "jobName": "execute-workflow", "workerId": "workflow-worker-11984", "queueName": "workflow", "timestamp": 1778824182854, "durationMs": 6260, "workspaceId": "default"}	019e2a2e-fc46-74bb-849d-226b18facfc6	019e2a2e-fc46-74bb-849d-226b18facfc6	\N	workflow-worker	1	1778824182854
019e2a2e-fd06-753a-bf90-71187b1582e0	workflow.step.failed	default	{"error": "HTTP request failed: fetch failed", "runId": "019e2a2e-e538-71ad-ac4c-cd60944b1a66", "stepId": "s1", "traceId": "019e2a2e-e538-71ad-ac4c-d27e3caf9d21"}	019e2a2e-fd06-753a-bf90-71187b1582e0	019e2a2e-fd06-753a-bf90-71187b1582e0	\N	workflow-worker	1	1778824183046
019e2a2e-fd0c-7518-9509-fc5acb2265f2	workflow.run.failed	default	{"runId": "019e2a2e-e538-71ad-ac4c-cd60944b1a66", "reason": "Step s1 failed: HTTP request failed: fetch failed", "traceId": "019e2a2e-e538-71ad-ac4c-d27e3caf9d21"}	019e2a2e-fd0c-7518-9509-fc5acb2265f2	019e2a2e-fd0c-7518-9509-fc5acb2265f2	\N	workflow-worker	1	1778824183052
019e2a2e-fd1a-72f2-820e-7b67af6c7a50	queue.job.completed	default	{"jobId": "019e2a2e-e538-71ad-ac4c-cd60944b1a66", "jobName": "execute-workflow", "workerId": "workflow-worker-13236", "queueName": "workflow", "timestamp": 1778824183066, "durationMs": 6109, "workspaceId": "default"}	019e2a2e-fd1a-72f2-820e-7b67af6c7a50	019e2a2e-fd1a-72f2-820e-7b67af6c7a50	\N	workflow-worker	1	1778824183066
019e2a2e-fd14-740c-893b-1d0e58fea4e7	observability.failure.linked	default	{"runId": "019e2a2e-e538-71ad-ac4c-cd60944b1a66", "failureId": "019e2a2e-fd11-709c-9ba9-608079d8ac29", "rootCause": "Step s1 failed: HTTP request failed: fetch failed", "timestamp": 1778824183057, "linkedEventIds": ["019e2a2e-fd11-709c-9ba9-5e209a5c74f8"]}	019e2a2e-e538-71ad-ac4c-d27e3caf9d21	019e2a2e-e538-71ad-ac4c-d27e3caf9d21	\N	observability-service	1	1778824183060
019e2a2f-28c3-747e-bcf8-d2348ba86ac3	dlq.job.retried	default	{"jobName": "executeWorkflowRun", "dlqJobId": "019e2a2e-fd0e-738c-87b2-d0be1aa36cf4", "queueName": "workflow-runs", "replayRunId": "019e2a2f-28b4-767d-9924-e48bdc2f8150"}	019e2a2f-28c3-747e-bcf8-d45e84395121	019e2a2f-28c3-747e-bcf8-db27855714d5	\N	api/dead-letter	1	1778824194243
019e2a2f-2a16-716c-89a1-14fa0118175a	dlq.job.retried	default	{"jobName": "executeWorkflowRun", "dlqJobId": "019e2a2e-fc0b-77af-b14d-4687629068b8", "queueName": "workflow-runs", "replayRunId": "019e2a2f-2a11-75e4-a7a6-b151b45ef122"}	019e2a2f-2a16-716c-89a1-1bf646963e8d	019e2a2f-2a16-716c-89a1-1ebe33a8838a	\N	api/dead-letter	1	1778824194582
019e2a2f-3f97-77ce-85cb-96d73a9056c9	workflow.run.retry-scheduled	default	{"runId": "019e2a2c-15ed-700f-ad86-93cbb396bb5b", "attempt": 2}	019e2a2f-3f97-77ce-85cb-96d73a9056c9	019e2a2f-3f97-77ce-85cb-96d73a9056c9	\N	recovery-worker	1	1778824200087
019e2a2f-3fb7-7668-a1bd-cea2fd23a153	workflow.run.retry-scheduled	default	{"runId": "019e2a2c-1766-711c-ba86-f012b9ed7d03", "attempt": 2}	019e2a2f-3fb7-7668-a1bd-cea2fd23a153	019e2a2f-3fb7-7668-a1bd-cea2fd23a153	\N	recovery-worker	1	1778824200119
019e2a2f-3fbd-71bf-abd6-758aa8006635	workflow.run.retry-scheduled	default	{"runId": "019e2a2c-0a14-72bc-93b7-db0e9832a320", "attempt": 2}	019e2a2f-3fbd-71bf-abd6-758aa8006635	019e2a2f-3fbd-71bf-abd6-758aa8006635	\N	recovery-worker	1	1778824200125
019e2a2f-3fc2-73ee-a565-93ce6f69a718	workflow.run.retry-scheduled	default	{"runId": "019e2a2c-0b91-77b0-8550-e808491fb484", "attempt": 2}	019e2a2f-3fc2-73ee-a565-93ce6f69a718	019e2a2f-3fc2-73ee-a565-93ce6f69a718	\N	recovery-worker	1	1778824200130
019e2a2f-3fc8-74e9-90d1-c7c74e4373a0	workflow.run.retry-scheduled	default	{"runId": "019e2a2c-0d1e-7219-b020-6e619b701baf", "attempt": 2}	019e2a2f-3fc8-74e9-90d1-c7c74e4373a0	019e2a2f-3fc8-74e9-90d1-c7c74e4373a0	\N	recovery-worker	1	1778824200136
019e2a2f-3fcd-727a-9178-6d12bd818c95	workflow.run.retry-scheduled	default	{"runId": "019e2a2c-0e88-725f-a375-d0c1033b7e02", "attempt": 2}	019e2a2f-3fcd-727a-9178-6d12bd818c95	019e2a2f-3fcd-727a-9178-6d12bd818c95	\N	recovery-worker	1	1778824200141
019e2a2f-3fd3-7594-abd4-8b7ee042d287	workflow.run.retry-scheduled	default	{"runId": "019e2a2c-1022-7091-8bbd-2df084dd2aaa", "attempt": 2}	019e2a2f-3fd3-7594-abd4-8b7ee042d287	019e2a2f-3fd3-7594-abd4-8b7ee042d287	\N	recovery-worker	1	1778824200147
019e2a2f-3fda-7438-aa73-1b300b4d7d31	workflow.run.retry-scheduled	default	{"runId": "019e2a2c-11a2-77d9-b232-03227413ab2d", "attempt": 2}	019e2a2f-3fda-7438-aa73-1b300b4d7d31	019e2a2f-3fda-7438-aa73-1b300b4d7d31	\N	recovery-worker	1	1778824200154
019e2a2f-3fe1-734d-b5fb-0c55d6811954	workflow.run.retry-scheduled	default	{"runId": "019e2a2c-1308-710a-a349-dc3e482b7aee", "attempt": 2}	019e2a2f-3fe1-734d-b5fb-0c55d6811954	019e2a2f-3fe1-734d-b5fb-0c55d6811954	\N	recovery-worker	1	1778824200161
019e2a2f-3fe6-7479-b993-f0e6270fc6b8	workflow.run.retry-scheduled	default	{"runId": "019e2a2c-146d-7148-a9b2-8a7cb4aef396", "attempt": 2}	019e2a2f-3fe6-7479-b993-f0e6270fc6b8	019e2a2f-3fe6-7479-b993-f0e6270fc6b8	\N	recovery-worker	1	1778824200166
019e2a2f-3feb-76ac-8c5f-d1226802cf00	workflow.run.retry-scheduled	default	{"runId": "019e2a2e-e229-771b-8a5a-f6e0140daf90", "attempt": 2}	019e2a2f-3feb-76ac-8c5f-d1226802cf00	019e2a2f-3feb-76ac-8c5f-d1226802cf00	\N	recovery-worker	1	1778824200171
019e2a2f-3ff1-717e-b776-5ec9f01ef4d8	workflow.run.retry-scheduled	default	{"runId": "019e2a2e-e3cc-772e-a956-dca340326f4e", "attempt": 2}	019e2a2f-3ff1-717e-b776-5ec9f01ef4d8	019e2a2f-3ff1-717e-b776-5ec9f01ef4d8	\N	recovery-worker	1	1778824200177
019e2a2f-3ff6-7378-8bd0-c069fdeab314	workflow.run.retry-scheduled	default	{"runId": "019e2a2e-e538-71ad-ac4c-cd60944b1a66", "attempt": 2}	019e2a2f-3ff6-7378-8bd0-c069fdeab314	019e2a2f-3ff6-7378-8bd0-c069fdeab314	\N	recovery-worker	1	1778824200182
019e2a33-d364-7669-ab6d-e147cc91c0e8	workflow.run.retry-scheduled	default	{"runId": "019e2a2f-dead-cafe-beef-deadbeef0001", "attempt": 2}	019e2a33-d364-7669-ab6d-e147cc91c0e8	019e2a33-d364-7669-ab6d-e147cc91c0e8	\N	recovery-worker	1	1778824500068
019e2a38-6730-7448-ac70-77c71a06849f	queue.job.started	default	{"jobId": "repeat:45eff3e3f0d6742b8108148d70a27173:1778824800000", "attempt": 1, "jobName": "analyze-memories", "workerId": "memory-worker-6296", "queueName": "memory", "timestamp": 1778824800047, "workspaceId": "default"}	019e2a38-6730-7448-ac70-7b0c002fc8f2	019e2a38-6730-7448-ac70-86c8c61b93cf	\N	memory-worker	1	1778824800048
019e2a38-6770-711a-8d33-44a4fff27053	analytics.ai-usage.aggregated	default	{"items": [{"date": "2026-05-15", "model": "claude-3-5-sonnet-20241022", "provider": "anthropic", "totalCost": 0.038, "totalReqs": 1, "totalTokens": 10220, "workspaceId": "default", "avgLatencyMs": 2340, "totalLatency": 2340}, {"date": "2026-05-14", "model": "claude-3-5-haiku-20241022", "provider": "anthropic", "totalCost": 0.006, "totalReqs": 1, "totalTokens": 3840, "workspaceId": "default", "avgLatencyMs": 820, "totalLatency": 820}, {"date": "2026-05-15", "model": "claude-3-5-sonnet", "provider": "anthropic", "totalCost": 0.0012, "totalReqs": 1, "totalTokens": 230, "workspaceId": "default", "avgLatencyMs": 850, "totalLatency": 850}], "aggregatedAt": 1778824800111}	019e2a38-6770-711a-8d33-4f26be13ce15	019e2a38-6770-711a-8d33-517a0a3cdf96	\N	analytics-worker	1	1778824800112
019e2a38-676f-7117-bad4-17c6acd1200b	analytics.workflow-metrics.aggregated	default	{"items": [{"date": "2026-05-15", "count": 15, "status": "pending", "workspaceId": "default", "avgDurationMs": null, "totalDuration": 0, "completedCount": 0}, {"date": "2026-05-15", "count": 22, "status": "completed", "workspaceId": "default", "avgDurationMs": 79, "totalDuration": 1734, "completedCount": 22}], "aggregatedAt": 1778824800110}	019e2a38-676f-7117-bad4-1f91c72200d5	019e2a38-676f-7117-bad4-253882411279	\N	analytics-worker	1	1778824800111
019e2a38-678b-788a-9a62-53f393680dac	optimization.risks.scored	default	{"updated": 2, "scoredAt": 1778824800128}	019e2a38-678c-788a-9a62-5957fbbeebe1	019e2a38-678c-788a-9a62-60eca7ec7090	\N	optimization-worker	1	1778824800140
019e2a38-67bd-7448-ac70-8e16ee00ab1b	queue.job.completed	default	{"jobId": "repeat:45eff3e3f0d6742b8108148d70a27173:1778824800000", "jobName": "analyze-memories", "workerId": "memory-worker-6296", "queueName": "memory", "timestamp": 1778824800189, "durationMs": 66542, "workspaceId": "default"}	019e2a38-67bd-7448-ac70-96eea1247101	019e2a38-67bd-7448-ac70-9e4c6e9fdacc	\N	memory-worker	1	1778824800189
019e2ca2-15b6-7488-9af8-82f9767a05e4	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-8", "durationMs": 158, "statusCode": 201}	019e2ca2-15b6-7488-9af8-86f4f5e51872	req-8	\N	audit-plugin	1	1778865280438
019e2ca2-3ae5-769b-919d-c6d6c4486c43	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-b86c-763a-8a50-a98db01c2b89/run", "method": "POST", "requestId": "req-h", "durationMs": 42, "statusCode": 202}	019e2ca2-3ae5-769b-919d-c891eca7653b	req-h	\N	audit-plugin	1	1778865289957
019e2ca2-3aea-76f9-90ec-6dd24c8e429a	queue.job.started	default	{"jobId": "019e2ca2-3ac5-7431-9573-3840e7cc190b", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-7696", "queueName": "workflow", "timestamp": 1778865289962, "workspaceId": "default"}	019e2ca2-3aea-76f9-90ec-6dd24c8e429a	019e2ca2-3aea-76f9-90ec-6dd24c8e429a	\N	workflow-worker	1	1778865289964
019e2ca2-3b54-7455-997d-5f30d7b3fd4b	workflow.run.started	default	{"runId": "019e2ca2-3ac5-7431-9573-3840e7cc190b", "traceId": "019e2ca2-3ac5-7431-9573-3f00dc49d731"}	019e2ca2-3b54-7455-997d-5f30d7b3fd4b	019e2ca2-3b54-7455-997d-5f30d7b3fd4b	\N	workflow-worker	1	1778865290068
019e2ca2-3d07-7771-a103-098bc9eee479	workflow.step.completed	default	{"runId": "019e2ca2-3ac5-7431-9573-3840e7cc190b", "stepId": "s1", "traceId": "019e2ca2-3ac5-7431-9573-3f00dc49d731"}	019e2ca2-3d07-7771-a103-098bc9eee479	019e2ca2-3d07-7771-a103-098bc9eee479	\N	workflow-worker	1	1778865290503
019e2ca2-3d4c-72d1-97d3-3681a7c35459	recovery.checkpoint.created	default	{"runId": "019e2ca2-3ac5-7431-9573-3840e7cc190b", "stepId": "s1", "timestamp": 1778865290516, "workspaceId": "default", "checkpointId": "019e2ca2-3d13-778c-86df-82aeac36400e"}	019e2ca2-3ac5-7431-9573-3f00dc49d731	019e2ca2-3ac5-7431-9573-3f00dc49d731	\N	recovery-service	1	1778865290572
019e2ca2-3d5d-7539-ab63-d9cf2b4bd307	workflow.run.completed	default	{"runId": "019e2ca2-3ac5-7431-9573-3840e7cc190b", "traceId": "019e2ca2-3ac5-7431-9573-3f00dc49d731", "durationMs": 427, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2ca2-3d5d-7539-ab63-d9cf2b4bd307	019e2ca2-3d5d-7539-ab63-d9cf2b4bd307	\N	workflow-worker	1	1778865290589
019e2ca2-3d6f-741c-b2e2-5b0667599ace	queue.job.completed	default	{"jobId": "019e2ca2-3ac5-7431-9573-3840e7cc190b", "jobName": "execute-workflow", "workerId": "workflow-worker-7696", "queueName": "workflow", "timestamp": 1778865290607, "durationMs": 667, "workspaceId": "default"}	019e2ca2-3d6f-741c-b2e2-5b0667599ace	019e2ca2-3d6f-741c-b2e2-5b0667599ace	\N	workflow-worker	1	1778865290608
019e2ca3-4cfa-7639-ae6a-858219c9a586	workflow.run.timeout	default	{"runId": "019e2a2f-dead-cafe-beef-deadbeef0099"}	019e2ca3-4cfa-7639-ae6a-858219c9a586	019e2ca3-4cfa-7639-ae6a-858219c9a586	\N	recovery-worker	1	1778865360122
019e2ca5-7bc2-7191-969c-a84ec86fcc1b	audit.api.mutation	default	{"url": "/api/v1/workflows", "method": "POST", "requestId": "req-m", "durationMs": 61, "statusCode": 201}	019e2ca5-7bc2-7191-969c-acd18e774f34	req-m	\N	audit-plugin	1	1778865503170
019e2ca5-9cd4-71e4-a178-2c33b95513e3	audit.api.mutation	default	{"url": "/api/v1/workflows/019e2a27-b86c-763a-8a50-a98db01c2b89/run", "method": "POST", "requestId": "req-v", "durationMs": 25, "statusCode": 202}	019e2ca5-9cd4-71e4-a178-308adcd8308d	req-v	\N	audit-plugin	1	1778865511636
019e2ca5-9cd6-708e-ac80-83f2616ff832	queue.job.started	default	{"jobId": "019e2ca5-9cbf-7202-9f66-f28e316915f6", "attempt": 1, "jobName": "execute-workflow", "workerId": "workflow-worker-7696", "queueName": "workflow", "timestamp": 1778865511638, "workspaceId": "default"}	019e2ca5-9cd6-708e-ac80-83f2616ff832	019e2ca5-9cd6-708e-ac80-83f2616ff832	\N	workflow-worker	1	1778865511638
019e2ca5-9d0f-7452-850d-98bd26ec62b9	workflow.run.started	default	{"runId": "019e2ca5-9cbf-7202-9f66-f28e316915f6", "traceId": "019e2ca5-9cbf-7202-9f66-f5ef00648282"}	019e2ca5-9d0f-7452-850d-98bd26ec62b9	019e2ca5-9d0f-7452-850d-98bd26ec62b9	\N	workflow-worker	1	1778865511695
019e2ca5-9e95-702f-b817-4ad42101b527	workflow.step.completed	default	{"runId": "019e2ca5-9cbf-7202-9f66-f28e316915f6", "stepId": "s1", "traceId": "019e2ca5-9cbf-7202-9f66-f5ef00648282"}	019e2ca5-9e95-702f-b817-4ad42101b527	019e2ca5-9e95-702f-b817-4ad42101b527	\N	workflow-worker	1	1778865512085
019e2ca5-9ed3-700d-a19c-a4ac525d4f19	recovery.checkpoint.created	default	{"runId": "019e2ca5-9cbf-7202-9f66-f28e316915f6", "stepId": "s1", "timestamp": 1778865512096, "workspaceId": "default", "checkpointId": "019e2ca5-9ea0-76dd-895c-43ce98b9e480"}	019e2ca5-9cbf-7202-9f66-f5ef00648282	019e2ca5-9cbf-7202-9f66-f5ef00648282	\N	recovery-service	1	1778865512147
019e2ca5-9ee6-703b-8c4e-24f20c974ea0	workflow.run.completed	default	{"runId": "019e2ca5-9cbf-7202-9f66-f28e316915f6", "traceId": "019e2ca5-9cbf-7202-9f66-f5ef00648282", "durationMs": 404, "stepsTotal": 1, "stepsFailed": 0, "stepsSuccess": 1}	019e2ca5-9ee6-703b-8c4e-24f20c974ea0	019e2ca5-9ee6-703b-8c4e-24f20c974ea0	\N	workflow-worker	1	1778865512166
019e2ca5-9f1f-7349-bb17-e8d419e58b7b	queue.job.completed	default	{"jobId": "019e2ca5-9cbf-7202-9f66-f28e316915f6", "jobName": "execute-workflow", "workerId": "workflow-worker-7696", "queueName": "workflow", "timestamp": 1778865512223, "durationMs": 591, "workspaceId": "default"}	019e2ca5-9f1f-7349-bb17-e8d419e58b7b	019e2ca5-9f1f-7349-bb17-e8d419e58b7b	\N	workflow-worker	1	1778865512223
019e2ca6-f697-757a-bfbc-ad7fb61516ff	workflow.run.retry-scheduled	default	{"runId": "019e2a2f-dead-cafe-beef-deadbeef0099", "attempt": 2}	019e2ca6-f697-757a-bfbc-ad7fb61516ff	019e2ca6-f697-757a-bfbc-ad7fb61516ff	\N	recovery-worker	1	1778865600151
\.


--
-- Data for Name: failure_lineages; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.failure_lineages (id, workspace_id, run_id, trace_id, root_cause, failure_chain, affected_steps, recovery_attempts, resolved, resolved_at, created_at, updated_at) FROM stdin;
019e2a1a-45aa-7197-bd3e-a1a1cac4ca4a	default	019e2a18-c41a-77db-b5b7-7d0605b1d852	019e2a18-c41a-77db-b5b7-82582a84d13d	there is no unique or exclusion constraint matching the ON CONFLICT specification	[{"eventId": "019e2a1a-45aa-7197-bd3e-9e7c6a4941cf", "message": "there is no unique or exclusion constraint matching the ON CONFLICT specification", "eventType": "workflow.run.failed", "timestamp": 1778822825386}]	{}	0	f	\N	1778822825386	1778822825386
019e2a2c-2250-772e-ab41-13fc2cc75ca5	default	019e2a2c-0a14-72bc-93b7-db0e9832a320	019e2a2c-0a14-72bc-93b7-dd7d17623973	Step s1 failed: HTTP request failed: fetch failed	[{"eventId": "019e2a2c-2250-772e-ab41-0d605dd561d2", "message": "Step s1 failed: HTTP request failed: fetch failed", "eventType": "workflow.run.failed", "timestamp": 1778823995984}]	{s1}	0	f	\N	1778823995984	1778823995984
019e2a2c-23db-7654-99a9-6082b1c174e6	default	019e2a2c-0b91-77b0-8550-e808491fb484	019e2a2c-0b91-77b0-8550-ef199b37d9c9	Step s1 failed: HTTP request failed: fetch failed	[{"eventId": "019e2a2c-23db-7654-99a9-5ca642b54dd3", "message": "Step s1 failed: HTTP request failed: fetch failed", "eventType": "workflow.run.failed", "timestamp": 1778823996379}]	{s1}	0	f	\N	1778823996379	1778823996379
019e2a2c-2502-730a-8d8d-4f7b71335437	default	019e2a2c-0d1e-7219-b020-6e619b701baf	019e2a2c-0d1e-7219-b020-70ec11d66e58	Step s1 failed: HTTP request failed: fetch failed	[{"eventId": "019e2a2c-2502-730a-8d8d-4a674aaa9023", "message": "Step s1 failed: HTTP request failed: fetch failed", "eventType": "workflow.run.failed", "timestamp": 1778823996674}]	{s1}	0	f	\N	1778823996674	1778823996674
019e2a2c-265f-761b-a91d-f7fc6297cc3a	default	019e2a2c-0e88-725f-a375-d0c1033b7e02	019e2a2c-0e88-725f-a375-d6a98359d140	Step s1 failed: HTTP request failed: fetch failed	[{"eventId": "019e2a2c-265f-761b-a91d-f0a494296fbe", "message": "Step s1 failed: HTTP request failed: fetch failed", "eventType": "workflow.run.failed", "timestamp": 1778823997023}]	{s1}	0	f	\N	1778823997023	1778823997023
019e2a2c-27e9-752e-86e1-c8d42f2c79cb	default	019e2a2c-1022-7091-8bbd-2df084dd2aaa	019e2a2c-1022-7091-8bbd-3186f9ca61e7	Step s1 failed: HTTP request failed: fetch failed	[{"eventId": "019e2a2c-27e9-752e-86e1-c71b0c83a69f", "message": "Step s1 failed: HTTP request failed: fetch failed", "eventType": "workflow.run.failed", "timestamp": 1778823997417}]	{s1}	0	f	\N	1778823997417	1778823997417
019e2a2c-2988-76b8-a770-ad5ff8c8be97	default	019e2a2c-11a2-77d9-b232-03227413ab2d	019e2a2c-11a2-77d9-b232-078b3add23ba	Step s1 failed: HTTP request failed: fetch failed	[{"eventId": "019e2a2c-2988-76b8-a770-aa80e7f4bb94", "message": "Step s1 failed: HTTP request failed: fetch failed", "eventType": "workflow.run.failed", "timestamp": 1778823997832}]	{s1}	0	f	\N	1778823997832	1778823997832
019e2a2c-2ae1-738d-8d8c-3fb3f72b7693	default	019e2a2c-1308-710a-a349-dc3e482b7aee	019e2a2c-1308-710a-a349-e2ffebeec275	Step s1 failed: HTTP request failed: fetch failed	[{"eventId": "019e2a2c-2ae1-738d-8d8c-3972618b2d38", "message": "Step s1 failed: HTTP request failed: fetch failed", "eventType": "workflow.run.failed", "timestamp": 1778823998177}]	{s1}	0	f	\N	1778823998177	1778823998177
019e2a2c-2c4f-7732-a43b-e4f4dc954a0b	default	019e2a2c-146d-7148-a9b2-8a7cb4aef396	019e2a2c-146d-7148-a9b2-8d6e837db21c	Step s1 failed: HTTP request failed: fetch failed	[{"eventId": "019e2a2c-2c4f-7732-a43b-e0ea82556b42", "message": "Step s1 failed: HTTP request failed: fetch failed", "eventType": "workflow.run.failed", "timestamp": 1778823998543}]	{s1}	0	f	\N	1778823998543	1778823998543
019e2a2c-2dcf-75dc-87b1-34b848a086f0	default	019e2a2c-15ed-700f-ad86-93cbb396bb5b	019e2a2c-15ed-700f-ad86-94cb71e730b7	Step s1 failed: HTTP request failed: fetch failed	[{"eventId": "019e2a2c-2dcf-75dc-87b1-33b46db7c6a4", "message": "Step s1 failed: HTTP request failed: fetch failed", "eventType": "workflow.run.failed", "timestamp": 1778823998927}]	{s1}	0	f	\N	1778823998927	1778823998927
019e2a2c-2f3f-742f-8da6-1d252eee3705	default	019e2a2c-1766-711c-ba86-f012b9ed7d03	019e2a2c-1766-711c-ba86-f58d40675229	Step s1 failed: HTTP request failed: fetch failed	[{"eventId": "019e2a2c-2f3e-71c8-8a47-6a394ccd6993", "message": "Step s1 failed: HTTP request failed: fetch failed", "eventType": "workflow.run.failed", "timestamp": 1778823999295}]	{s1}	0	f	\N	1778823999295	1778823999295
019e2a2e-fa7e-7292-ab11-3cebdb18ec95	default	019e2a2e-e229-771b-8a5a-f6e0140daf90	019e2a2e-e22a-75d9-8934-8b2f4f063032	Step s1 failed: HTTP request failed: fetch failed	[{"eventId": "019e2a2e-fa7e-7292-ab11-3851ea89da6d", "message": "Step s1 failed: HTTP request failed: fetch failed", "eventType": "workflow.run.failed", "timestamp": 1778824182398}]	{s1}	0	f	\N	1778824182398	1778824182398
019e2a2e-fc0e-756b-9086-f41375e32a1f	default	019e2a2e-e3cc-772e-a956-dca340326f4e	019e2a2e-e3cc-772e-a956-e2ba924719bb	Step s1 failed: HTTP request failed: fetch failed	[{"eventId": "019e2a2e-fc0e-756b-9086-f270b918cca5", "message": "Step s1 failed: HTTP request failed: fetch failed", "eventType": "workflow.run.failed", "timestamp": 1778824182798}]	{s1}	0	f	\N	1778824182798	1778824182798
019e2a2e-fd11-709c-9ba9-608079d8ac29	default	019e2a2e-e538-71ad-ac4c-cd60944b1a66	019e2a2e-e538-71ad-ac4c-d27e3caf9d21	Step s1 failed: HTTP request failed: fetch failed	[{"eventId": "019e2a2e-fd11-709c-9ba9-5e209a5c74f8", "message": "Step s1 failed: HTTP request failed: fetch failed", "eventType": "workflow.run.failed", "timestamp": 1778824183057}]	{s1}	0	f	\N	1778824183057	1778824183057
\.


--
-- Data for Name: insights; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.insights (id, workspace_id, title, body, category, confidence, source, source_ref, tags, embedding, dismissed, acted_on, expires_at, created_at) FROM stdin;
019e2a13-9e34-75dd-bcc5-ce35d8e684b2	default	Revenue concentration risk: top 5 accounts = 38% of MRR	Five enterprise accounts contribute 38% of total MRR. If any two churn simultaneously, monthly revenue drops by more than 15%. Recommend accelerating mid-market diversification to reduce concentration below 25% by Q3.	revenue	0.93	ai-analyst	\N	{concentration,risk,mrr}	\N	f	f	\N	1778735989214
019e2a13-9e34-75dd-bcc5-d24ce710ee9f	default	Onboarding completion at day-3 predicts 90-day retention with 79% accuracy	Analysis of 2,400 accounts shows that users who complete the onboarding checklist within 3 days have a 91% retention rate at 90 days vs 41% for those who do not. Prioritising onboarding nudges in the first 72 hours is the highest-leverage retention lever available.	product	0.88	ai-analyst	\N	{onboarding,retention,prediction}	\N	f	t	\N	1778563189214
019e2a13-9e34-75dd-bcc5-d79a202d0b21	default	Tuesday morning sends outperform Friday sends by 31% in email open rate	Review of 180-day email campaign data shows Tuesday 8–10am sends achieve 31.4% open rates vs 24.1% on Fridays. Scheduling the next pricing campaign for Tuesday 8am is expected to reach 3,200 additional recipients in the active window.	marketing	0.81	ai-analyst	\N	{email,timing,campaigns}	\N	f	f	\N	1778390389214
019e2a13-9e34-75dd-bcc5-db8f620133f1	default	AI workflow usage correlates with 2.1x higher NPS	Accounts actively using AI-generated briefings (≥3 per week) report an average NPS of 81 vs 39 for non-users. This suggests AI features are a primary satisfaction driver and should anchor the renewal and upsell narrative.	product	0.85	ai-analyst	\N	{ai,nps,satisfaction}	\N	f	f	\N	1778217589214
019e2a13-9e34-75dd-bcc5-deaae426f4e4	default	Opportunity pipeline value increased 48% in the last 30 days	The combined estimated value of opportunities in "identified" and "evaluating" status grew from $148K to $219K over the past 30 days. Top contributors: Gamma Analytics partnership ($120K) and mid-market expansion ($60K). If both convert, H2 revenue targets are materially de-risked.	strategic	0.79	ai-analyst	\N	{opportunities,pipeline,growth}	\N	f	f	\N	1778649589214
\.


--
-- Data for Name: memories; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.memories (id, workspace_id, type, content, summary, embedding, confidence, tags, source, source_ref, created_at, updated_at, expires_at) FROM stdin;
019e2a13-9e1a-7209-9267-449676b83f8e	default	fact	Acme Corp achieved 185K MRR in Q1 2026, up 22% QoQ.	MRR hit 185K (+22% QoQ)	\N	0.98	{finance,mrr,growth}	briefing	019e2a13-9ddf-73e1-ac5c-7beb421c1224	1778390389214	1778390389214	\N
019e2a13-9e1a-7209-9267-4a412016a2ea	default	observation	Customer churn spiked to 4.8% in the enterprise segment during March due to a pricing change.	Enterprise churn spike 4.8% (March)	\N	0.85	{churn,enterprise,pricing}	analytics	\N	1778131189214	1778131189214	\N
019e2a13-9e1a-7209-9267-4dbc29b95aab	default	decision	Decided to accelerate the AI feature roadmap and deprioritize the mobile app rewrite until Q3.	AI roadmap accelerated; mobile deferred to Q3	\N	1	{strategy,roadmap,ai}	meeting	meeting-2026-04-01	1777785589214	1777785589214	\N
019e2a13-9e1a-7209-9267-535e1112e616	default	lesson	Outbound campaigns perform 2.3x better when triggered within 24h of a product usage milestone.	Milestone-triggered outbound 2.3x more effective	\N	0.88	{sales,outbound,timing}	experiment	\N	1777094389214	1777094389214	\N
019e2a13-9e1a-7209-9267-57cc1d3e6896	default	goal	Reach 250K MRR by end of Q2 2026 by expanding into mid-market accounts.	250K MRR by Q2 2026	\N	0.9	{goal,mrr,mid-market}	planning	\N	1777612789214	1777612789214	\N
019e2a13-9e1a-7209-9267-5b79142c257d	default	strategic	Partnership with Gamma Analytics could unlock distribution to 12K enterprise users at near-zero CAC.	Gamma partnership = 12K user distribution opportunity	\N	0.75	{partnerships,distribution,gamma}	briefing	\N	1778563189214	1778563189214	\N
019e2a13-9e1a-7209-9267-5c3e84aa695c	default	operational	Weekly AI batch processing runs consume an average of $340 in API costs; caching embeddings cuts this by 60%.	AI costs $340/week; caching saves 60%	\N	0.95	{costs,ai,optimization}	monitoring	\N	1778303989214	1778303989214	\N
019e2a13-9e1a-7209-9267-6067b2654a11	default	idea	Build an AI-powered competitive intelligence digest that summarizes competitor product releases weekly.	Weekly AI competitor digest idea	\N	0.7	{product,competitive-intelligence,idea}	brainstorm	\N	1778044789214	1778044789214	\N
019e2a13-9e1a-7209-9267-6632ff4554a1	default	observation	The free-to-paid conversion rate increased from 6.2% to 9.1% after adding contextual upgrade prompts.	Conversion rate improved to 9.1% (+2.9pp)	\N	0.93	{conversion,growth,freemium}	analytics	\N	1778476789214	1778476789214	\N
019e2a13-9e1a-7209-9267-69d6617b3035	default	fact	Support ticket volume correlates (r=0.82) with the number of new features released per sprint.	Feature velocity drives support volume (r=0.82)	\N	0.87	{support,engineering,velocity}	analysis	\N	1777871989214	1777871989214	\N
019e2a19-8885-7688-a4f5-f8c89d09affe	default	observation	RC1 test memory	\N	\N	1	{rc1}	api	\N	1778822776965	1778822776965	\N
019e2a28-ebe1-7783-a333-b87042cfdb44	default	observation	LongRun memory test 1: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	\N	\N	1	{}	api	\N	1778823785441	1778823785441	\N
019e2a28-edc5-7298-87e9-cae28715a4bb	default	decision	LongRun memory test 2: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	\N	\N	1	{}	api	\N	1778823785925	1778823785925	\N
019e2a28-efa9-725a-81ad-8967e621caf9	default	lesson	LongRun memory test 3: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	\N	\N	1	{}	api	\N	1778823786409	1778823786409	\N
019e2a28-f18f-77e7-a89a-723d028ac775	default	goal	LongRun memory test 4: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	\N	\N	1	{}	api	\N	1778823786895	1778823786895	\N
019e2a28-f352-768b-9d75-7639343e050b	default	idea	LongRun memory test 5: platform stability at sustained load. Ops platform handles high concurrency with BullMQ workers.	\N	\N	1	{}	api	\N	1778823787346	1778823787346	\N
\.


--
-- Data for Name: notifications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notifications (id, workspace_id, title, body, type, category, read, dismissed, source_type, source_id, action_url, expires_at, created_at) FROM stdin;
019e2a13-9e3f-70c0-b4f6-d0827b7eaa3f	default	Critical risk: Key account renewals at risk	Three enterprise accounts with combined ARR of $210K have not logged in for 45+ days. Renewal dates are within 60 days.	error	risk	f	f	risk	\N	/risks	\N	1778649589214
019e2a13-9e3f-70c0-b4f6-d5fcff504a96	default	Executive briefing ready	Your daily briefing for May 13 is ready. 12 items across priorities, risks, and opportunities.	info	workflow	t	f	briefing	019e2a13-9ddf-73e1-ac5c-7f24d7d80b8c	/briefings	\N	1778735989214
019e2a13-9e3f-70c0-b4f6-d8d0d8e5ab0a	default	Approval required: Send pricing email	Workflow "Q2 Pricing Campaign" is awaiting your approval before sending to 3,400 subscribers.	warning	approval	f	f	workflow_run	\N	/approvals	\N	1778563189214
019e2a13-9e3f-70c0-b4f6-dc742ecf9455	default	Goal on track: 250K MRR target	You are 74% toward the Q2 MRR goal with 47 days remaining. Current trajectory suggests on-time completion.	success	goal	t	f	strategic_goal	\N	/goals	\N	1778476789214
019e2a13-9e3f-70c0-b4f6-e311c94770b4	default	New high-confidence opportunity identified	AI scanner identified a partnership opportunity with Gamma Analytics scored at 0.88 — highest in 30 days.	info	opportunity	f	f	opportunity	\N	/opportunities	\N	1778649589214
\.


--
-- Data for Name: opportunities; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.opportunities (id, workspace_id, business_id, title, description, type, status, priority, value_potential, confidence, category, evidence, tags, estimated_roi, estimated_effort, risk_level, strategic_alignment, score, score_breakdown, linked_memory_ids, linked_workflow_ids, converted_run_id, converted_workflow_id, converted_at, accepted_at, rejected_at, due_date, closed_at, created_at, updated_at) FROM stdin;
019e2a13-9e26-766b-afc4-a2dfa48dc4ad	default	019e2a13-9dde-742c-b38a-3ad3b0afdde4	Mid-market expansion via inside sales	Companies with 50–200 employees are underserved by current self-serve motion. A 3-person inside sales team could add 40–60K MRR within 6 months.	strategic	evaluating	90	60000	0.84	growth	[{"note": "TAM in 50-200 employee segment: 8,400 companies", "type": "analysis"}]	{sales,mid-market,expansion}	4.2	high	medium	0.91	0.84	{"roi": 0.88, "risk": 0.75, "effort": 0.6, "alignment": 0.91}	{}	{}	\N	\N	\N	\N	\N	\N	\N	1778563189214	1778735989214
019e2a13-9e26-766b-afc4-a53ca2fa625b	default	019e2a13-9dde-742c-b38a-3ad3b0afdde4	AI-powered onboarding automation	Replace the 5-step manual onboarding checklist with an AI guide that adapts to user role and industry, projected to cut time-to-value from 14 days to 4.	automation	identified	80	28000	0.78	retention	[{"note": "64% of churned users cited slow onboarding", "type": "user-research"}]	{ai,onboarding,retention}	3.1	medium	low	0.85	0.79	{"roi": 0.77, "risk": 0.9, "effort": 0.8, "alignment": 0.85}	{}	{}	\N	\N	\N	\N	\N	\N	\N	1778390389214	1778649589214
019e2a13-9e26-766b-afc4-abefa971fb50	default	019e2a13-9ddf-73e1-ac5c-61e9cfb13b3f	Gamma Analytics distribution partnership	Co-sell agreement with Gamma Analytics to offer Acme as a native integration to their 12K enterprise users. Estimated 300–500 qualified leads in year one.	business	evaluating	95	120000	0.72	partnerships	[{"note": "Initial partnership call held 2026-05-02", "type": "conversation"}]	{partnership,distribution,enterprise}	6.5	medium	low	0.94	0.88	{"roi": 0.95, "risk": 0.9, "effort": 0.8, "alignment": 0.94}	{}	{}	\N	\N	\N	\N	\N	\N	\N	1778649589214	1778735989214
019e2a13-9e26-766b-afc4-ae7aa314c1b4	default	019e2a13-9dde-742c-b38a-3ad3b0afdde4	Annual plan upsell campaign	Target the 340 monthly subscribers with >6 months tenure for an annual plan migration. Projected to lock in 1.4M ARR and reduce churn exposure.	revenue	identified	75	42000	0.88	monetization	[{"note": "6mo+ users have 1.2% monthly churn vs 3.4% overall", "type": "cohort-analysis"}]	{upsell,annual-plan,retention}	2.8	low	low	0.82	0.83	{"roi": 0.73, "risk": 0.9, "effort": 0.95, "alignment": 0.82}	{}	{}	\N	\N	\N	\N	\N	\N	\N	1778217589214	1778563189214
019e2a13-9e26-766b-afc4-b2b8f46c691f	default	019e2a13-9ddf-73e1-ac5c-5cea6a973c99	Beta Ventures fintech integration	Beta Ventures needs a real-time transaction categorisation API. Building this as a paid add-on could serve the broader fintech vertical.	operational	identified	55	15000	0.65	product	[{"note": "Feature request submitted by Beta Ventures CTO", "type": "customer-request"}]	{fintech,api,integration}	1.8	high	medium	0.6	0.57	{"roi": 0.48, "risk": 0.7, "effort": 0.4, "alignment": 0.6}	{}	{}	\N	\N	\N	\N	\N	\N	\N	1777958389214	1778303989214
\.


--
-- Data for Name: policy_traces; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.policy_traces (id, workspace_id, trace_id, policy_id, policy_name, action, verdict, risk_level, agent_id, checked_at, created_at) FROM stdin;
\.


--
-- Data for Name: queue_traces; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.queue_traces (id, workspace_id, trace_id, queue_name, job_id, job_name, event, duration_ms, attempt, error, created_at) FROM stdin;
\.


--
-- Data for Name: recovery_checkpoints; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.recovery_checkpoints (id, workspace_id, run_id, step_id, trace_id, completed_steps, state, snapshot_id, restored_at, restored_by, created_at) FROM stdin;
019e2a1f-2e89-71ed-a558-506384b5e749	default	019e2a1f-2dd0-7016-b332-35d7f32f18df	step1	019e2a1f-2dd0-7016-b332-380d9917ae83	{step1}	{"output": {"type": "delay", "skipped": true}}	\N	\N	\N	1778823147145
019e2a1f-dae9-7479-956f-343525287879	default	019e2a1f-da6a-7695-8f18-5986320d4ebc	step1	019e2a1f-da6a-7695-8f18-5d600625aa81	{step1}	{"output": {"type": "http", "skipped": true}}	\N	\N	\N	1778823191273
019e2a27-e78e-73da-b893-ecf59291a1a1	default	019e2a27-e6f5-70fd-a796-5b4e43099e1a	s1	019e2a27-e6f5-70fd-a796-5fe06ab1981c	{s1}	{"output": {"type": "delay", "skipped": true}}	\N	\N	\N	1778823718798
019e2a27-e8ce-738b-8f15-ca35bdf04cac	default	019e2a27-e87f-7203-9c33-a97d8d196838	s1	019e2a27-e87f-7203-9c33-ad596cbab721	{s1}	{"output": {"type": "delay", "skipped": true}}	\N	\N	\N	1778823719118
019e2a27-ea4f-72f3-98b9-38a92877ffa0	default	019e2a27-e9fb-75ff-8604-662549188e42	s1	019e2a27-e9fb-75ff-8604-6a20f882bd59	{s1}	{"output": {"type": "delay", "skipped": true}}	\N	\N	\N	1778823719503
019e2a27-ebb3-719a-b25e-e4fbdbe1d7a1	default	019e2a27-eb6c-7798-9e77-b3cd111301dc	s1	019e2a27-eb6c-7798-9e77-b58d28604493	{s1}	{"output": {"type": "delay", "skipped": true}}	\N	\N	\N	1778823719859
019e2a27-ed18-772a-aa21-9ce79f52ffb6	default	019e2a27-ecd1-734c-baed-bf50bb7a3ebe	s1	019e2a27-ecd1-734c-baed-c05113a4cb53	{s1}	{"output": {"type": "delay", "skipped": true}}	\N	\N	\N	1778823720216
019e2a27-ee98-77d9-992d-90a6f7be35a1	default	019e2a27-ee55-716e-b73e-47dff9244354	s1	019e2a27-ee55-716e-b73e-489cdb9554a8	{s1}	{"output": {"type": "delay", "skipped": true}}	\N	\N	\N	1778823720600
019e2a27-f01a-710d-9530-dbcca8f7c43a	default	019e2a27-efd8-77bb-8d9b-728ff860c105	s1	019e2a27-efd8-77bb-8d9b-7562dd76c055	{s1}	{"output": {"type": "delay", "skipped": true}}	\N	\N	\N	1778823720986
019e2a27-f18b-7008-bf64-ba91a0cb45a3	default	019e2a27-f135-763e-89f1-9cfbf82a21c9	s1	019e2a27-f135-763e-89f1-a3a33a781ce2	{s1}	{"output": {"type": "delay", "skipped": true}}	\N	\N	\N	1778823721355
019e2a27-f305-754e-a1d2-2e7e343c85ba	default	019e2a27-f2b4-75ff-89f8-4c68f77711fe	s1	019e2a27-f2b4-75ff-89f8-501eba7413bd	{s1}	{"output": {"type": "delay", "skipped": true}}	\N	\N	\N	1778823721733
019e2a27-f46e-709e-bb36-b66a20b7ed53	default	019e2a27-f420-7482-a357-cc9aca9a86a0	s1	019e2a27-f420-7482-a357-d307e0be459a	{s1}	{"output": {"type": "delay", "skipped": true}}	\N	\N	\N	1778823722094
019e2a28-677e-7126-91f1-eb6e3565ba6d	default	019e2a28-6728-71b9-aa98-5541ae7d8827	s1	019e2a28-6728-71b9-aa98-5a880110fecb	{s1}	{"output": {"type": "http", "skipped": true}}	\N	\N	\N	1778823751550
019e2a28-690a-726b-8af0-73d888cf28fb	default	019e2a28-68b9-7473-b384-992b3f8dae23	s1	019e2a28-68b9-7473-b384-9ce725ac3917	{s1}	{"output": {"type": "http", "skipped": true}}	\N	\N	\N	1778823751946
019e2a28-6a5b-765c-9151-977f9bc2089d	default	019e2a28-6a24-70ed-a172-134d40f5840a	s1	019e2a28-6a24-70ed-a172-17b01950a6d8	{s1}	{"output": {"type": "http", "skipped": true}}	\N	\N	\N	1778823752283
019e2a28-6bf5-775e-a102-784d686651b9	default	019e2a28-6ba8-764a-8dab-cc0cd36719c5	s1	019e2a28-6ba8-764a-8dab-d389e1bb96b1	{s1}	{"output": {"type": "http", "skipped": true}}	\N	\N	\N	1778823752693
019e2a28-6d95-71b9-bbac-8c48e0eb725c	default	019e2a28-6d38-77fa-8f1e-d39c173ef939	s1	019e2a28-6d38-77fa-8f1e-d72e5d8f5586	{s1}	{"output": {"type": "http", "skipped": true}}	\N	\N	\N	1778823753109
019e2a28-6f02-775e-81f0-8ce5a7b7be76	default	019e2a28-6eba-756e-8b38-cd5ab01cc825	s1	019e2a28-6eba-756e-8b38-d3ee2efaf506	{s1}	{"output": {"type": "http", "skipped": true}}	\N	\N	\N	1778823753474
019e2a28-7063-77d9-9699-c739d4d55f1d	default	019e2a28-7015-70d4-a603-728242725f76	s1	019e2a28-7015-70d4-a603-740c0f7040fc	{s1}	{"output": {"type": "http", "skipped": true}}	\N	\N	\N	1778823753827
019e2a28-71e3-7763-adc0-50199de7c932	default	019e2a28-718b-76db-a7ae-eae07ef816c0	s1	019e2a28-718b-76db-a7ae-ede6dac1c055	{s1}	{"output": {"type": "http", "skipped": true}}	\N	\N	\N	1778823754211
019e2a28-7364-74fb-9b3a-a8a76f603938	default	019e2a28-730d-7229-84d8-bf4667b361ae	s1	019e2a28-730d-7229-84d8-c10e6812af0a	{s1}	{"output": {"type": "http", "skipped": true}}	\N	\N	\N	1778823754596
019e2a28-74c3-722f-9c55-316a812e3f99	default	019e2a28-7482-7564-8317-65cfabf5f758	s1	019e2a28-7482-7564-8317-6bcbb6775255	{s1}	{"output": {"type": "http", "skipped": true}}	\N	\N	\N	1778823754947
019e2ca2-3d13-778c-86df-82aeac36400e	default	019e2ca2-3ac5-7431-9573-3840e7cc190b	s1	019e2ca2-3ac5-7431-9573-3f00dc49d731	{s1}	{"output": {"waited": 300}}	\N	\N	\N	1778865290516
019e2ca5-9ea0-76dd-895c-43ce98b9e480	default	019e2ca5-9cbf-7202-9f66-f28e316915f6	s1	019e2ca5-9cbf-7202-9f66-f5ef00648282	{s1}	{"output": {"waited": 300}}	\N	\N	\N	1778865512096
\.


--
-- Data for Name: recovery_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.recovery_log (id, workspace_id, run_id, strategy, reason, steps, status, started_at, completed_at, error) FROM stdin;
\.


--
-- Data for Name: risks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.risks (id, workspace_id, business_id, title, description, severity, probability, impact, risk_score, category, status, mitigations, detected_at, resolved_at, created_at, updated_at) FROM stdin;
019e2a13-9e2b-760c-ab64-5a8467a9d279	default	019e2a13-9ddf-73e1-ac5c-5cea6a973c99	Beta Ventures burn rate	Beta Ventures has 7 months of runway at current burn. Without new funding or revenue growth, they may need to cut the Acme subscription.	medium	0.4	0.3	0.12	customer	monitoring	[{"owner": "sales", "action": "Offer flexible billing terms and usage-based discount", "dueDate": 1781414389214}]	1778217589214	\N	1778217589214	1778390389214
019e2a13-9e2b-760c-ab64-5ed660dd9d36	default	019e2a13-9dde-742c-b38a-3ad3b0afdde4	Competitor feature parity threat	A well-funded competitor released workflow automation in beta. Early reviews indicate feature parity with our core offering within 3–6 months.	high	0.6	0.65	0.39	competitive	open	[{"owner": "product", "action": "Accelerate differentiating AI features to Q2", "dueDate": 1782710389214}, {"owner": "sales-enablement", "action": "Brief sales team on competitive objection handling", "dueDate": 1779686389214}]	1778044789214	\N	1778044789214	1778476789214
019e2a13-9e2b-760c-ab64-6143c420a68f	default	019e2a13-9dde-742c-b38a-3ad3b0afdde4	Data privacy compliance gap	GDPR audit identified that AI-generated memory records may contain PII that is not subject to automated deletion schedules.	medium	0.35	0.55	0.19	compliance	in_progress	[{"owner": "engineering", "action": "Implement PII scanning on memory ingestion", "dueDate": 1780636789214}, {"owner": "engineering", "action": "Add automated expiry to memory records with detected PII", "dueDate": 1781241589214}]	1777785589214	\N	1777785589214	1778563189214
019e2a13-9e2b-760c-ab64-56d846d3d9cc	default	019e2a13-9dde-742c-b38a-3ad3b0afdde4	AI provider rate limit exposure	Current usage is at 82% of Anthropic tier-2 rate limits. A spike during batch briefing jobs could cause cascading failures.	high	0.55	0.7	0.385	technical	open	[{"owner": "engineering", "action": "Implement exponential backoff and queue smoothing", "dueDate": 1780031989214}, {"owner": "ops", "action": "Apply for Anthropic tier-3 upgrade", "dueDate": 1779427189214}]	1778476789214	\N	1778476789214	1778824800128
019e2a13-9e2b-760c-ab64-52e3c9a409db	default	019e2a13-9dde-742c-b38a-3ad3b0afdde4	Key account renewal at risk	Three enterprise accounts (combined ARR 210K) have not logged in for 45+ days and renewal dates are within 60 days.	critical	0.68	0.95	0.646	revenue	open	[{"owner": "CS lead", "action": "Schedule executive business reviews", "dueDate": 1779427189214}, {"owner": "ops", "action": "Activate dedicated success manager", "dueDate": 1779081589214}]	1778649589214	\N	1778649589214	1778824800128
\.


--
-- Data for Name: rollback_requests; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.rollback_requests (id, workspace_id, run_id, snapshot_id, trace_id, status, reason, requested_by, started_at, completed_at, created_at) FROM stdin;
\.


--
-- Data for Name: rollback_results; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.rollback_results (id, request_id, workspace_id, item_id, status, error, restored_at, created_at) FROM stdin;
\.


--
-- Data for Name: scheduled_triggers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.scheduled_triggers (id, workspace_id, name, description, workflow_id, cron_expression, timezone, enabled, last_run_at, next_run_at, last_run_status, run_count, failure_count, payload, created_at, updated_at) FROM stdin;
019e2a19-8862-778b-bb54-30507c026b0d	default	RC1 Health Check	\N	019e2a18-c402-7338-bdab-25577b1d9897	*/5 * * * *	UTC	t	\N	1778826376930	\N	0	0	\N	1778822776930	1778822776930
\.


--
-- Data for Name: snapshot_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.snapshot_items (id, snapshot_id, workspace_id, item_type, entity_type, entity_id, before_state, metadata, created_at) FROM stdin;
\.


--
-- Data for Name: snapshots; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.snapshots (id, workspace_id, run_id, step_id, trace_id, status, description, item_count, size_bytes, expires_at, created_at) FROM stdin;
\.


--
-- Data for Name: step_runs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.step_runs (id, run_id, step_id, workspace_id, status, started_at, completed_at, output, error, attempt, rollback) FROM stdin;
019e2a1f-2e51-7329-ba46-7d01ba5b6df0	019e2a1f-2dd0-7016-b332-35d7f32f18df	step1	default	completed	1778823147089	1778823147131	{"type": "delay", "skipped": true}	\N	1	\N
019e2a2c-2db3-75de-80b3-eb2f1fd65aba	019e2a2c-15ed-700f-ad86-93cbb396bb5b	s1	default	failed	1778823998899	1778823998910	\N	HTTP request failed: fetch failed	3	\N
019e2a1f-dabf-75c3-9612-822c8579c057	019e2a1f-da6a-7695-8f18-5986320d4ebc	step1	default	completed	1778823191231	1778823191258	{"type": "http", "skipped": true}	\N	1	\N
019e2a2c-1781-714d-8b49-617373c1ddff	019e2a2c-1766-711c-ba86-f012b9ed7d03	s1	default	failed	1778823993217	1778823999276	\N	HTTP request failed: fetch failed	3	\N
019e2a27-e751-70be-ad65-93f7e93118c2	019e2a27-e6f5-70fd-a796-5b4e43099e1a	s1	default	completed	1778823718737	1778823718786	{"type": "delay", "skipped": true}	\N	1	\N
019e2a2c-1f61-75e1-a355-56f3cd22f649	019e2a2c-1766-711c-ba86-f012b9ed7d03	s1	default	failed	1778823995233	1778823999276	\N	HTTP request failed: fetch failed	3	\N
019e2a27-e89b-74df-9e57-b551e2a2e1bd	019e2a27-e87f-7203-9c33-a97d8d196838	s1	default	completed	1778823719067	1778823719097	{"type": "delay", "skipped": true}	\N	1	\N
019e2a27-ea1c-7199-9afa-d875a75fe1b9	019e2a27-e9fb-75ff-8604-662549188e42	s1	default	completed	1778823719452	1778823719490	{"type": "delay", "skipped": true}	\N	1	\N
019e2a27-eb87-739a-98e8-7d6339c4a1ee	019e2a27-eb6c-7798-9e77-b3cd111301dc	s1	default	completed	1778823719815	1778823719846	{"type": "delay", "skipped": true}	\N	1	\N
019e2a27-ecec-767a-af86-a23fda029997	019e2a27-ecd1-734c-baed-bf50bb7a3ebe	s1	default	completed	1778823720172	1778823720204	{"type": "delay", "skipped": true}	\N	1	\N
019e2a27-ee6f-709d-8fd9-52c949a3b68d	019e2a27-ee55-716e-b73e-47dff9244354	s1	default	completed	1778823720559	1778823720589	{"type": "delay", "skipped": true}	\N	1	\N
019e2a27-eff4-7248-92ad-1cc2d03af1ef	019e2a27-efd8-77bb-8d9b-728ff860c105	s1	default	completed	1778823720948	1778823720974	{"type": "delay", "skipped": true}	\N	1	\N
019e2a2e-e42f-71eb-853e-bbd481834027	019e2a2e-e3cc-772e-a956-dca340326f4e	s1	default	failed	1778824176687	1778824182773	\N	HTTP request failed: fetch failed	3	\N
019e2a27-f14c-752e-b468-1c1e921cb2f6	019e2a27-f135-763e-89f1-9cfbf82a21c9	s1	default	completed	1778823721292	1778823721344	{"type": "delay", "skipped": true}	\N	1	\N
019e2a27-f2cb-761b-866c-dfd6355f6092	019e2a27-f2b4-75ff-89f8-4c68f77711fe	s1	default	completed	1778823721675	1778823721721	{"type": "delay", "skipped": true}	\N	1	\N
019e2a27-f43a-72ad-973e-2a3103bdde06	019e2a27-f420-7482-a357-cc9aca9a86a0	s1	default	completed	1778823722042	1778823722068	{"type": "delay", "skipped": true}	\N	1	\N
019e2a28-6752-773c-8d4e-c0cdf35afcca	019e2a28-6728-71b9-aa98-5541ae7d8827	s1	default	completed	1778823751506	1778823751541	{"type": "http", "skipped": true}	\N	1	\N
019e2a28-68d1-7340-9df0-dabc907af402	019e2a28-68b9-7473-b384-992b3f8dae23	s1	default	completed	1778823751889	1778823751933	{"type": "http", "skipped": true}	\N	1	\N
019e2a28-6a37-7071-b991-12a379b03323	019e2a28-6a24-70ed-a172-134d40f5840a	s1	default	completed	1778823752247	1778823752273	{"type": "http", "skipped": true}	\N	1	\N
019e2a28-6bc3-7678-a59c-85c40afcefdd	019e2a28-6ba8-764a-8dab-cc0cd36719c5	s1	default	completed	1778823752643	1778823752680	{"type": "http", "skipped": true}	\N	1	\N
019e2a28-6d53-727d-b449-b990ed4566a1	019e2a28-6d38-77fa-8f1e-d39c173ef939	s1	default	completed	1778823753043	1778823753093	{"type": "http", "skipped": true}	\N	1	\N
019e2a28-6ed8-715b-a3cd-d522ff442707	019e2a28-6eba-756e-8b38-cd5ab01cc825	s1	default	completed	1778823753432	1778823753462	{"type": "http", "skipped": true}	\N	1	\N
019e2a28-7036-7407-a842-d813d4088355	019e2a28-7015-70d4-a603-728242725f76	s1	default	completed	1778823753782	1778823753814	{"type": "http", "skipped": true}	\N	1	\N
019e2a28-71a2-744d-8516-f29e2d8dae04	019e2a28-718b-76db-a7ae-eae07ef816c0	s1	default	completed	1778823754147	1778823754199	{"type": "http", "skipped": true}	\N	1	\N
019e2a28-7338-77d2-9855-6c43e3b943fb	019e2a28-730d-7229-84d8-bf4667b361ae	s1	default	completed	1778823754552	1778823754583	{"type": "http", "skipped": true}	\N	1	\N
019e2a28-749c-72c2-94fd-a8a7e7586c1a	019e2a28-7482-7564-8317-65cfabf5f758	s1	default	completed	1778823754908	1778823754935	{"type": "http", "skipped": true}	\N	1	\N
019e2a2c-0bf0-7252-aa8f-04aae5c85aed	019e2a2c-0b91-77b0-8550-e808491fb484	s1	default	failed	1778823990256	1778823996352	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-0d39-73d9-935c-d934e50658d9	019e2a2c-0d1e-7219-b020-6e619b701baf	s1	default	failed	1778823990585	1778823996658	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-0e9e-73de-8c5e-ec6850eb1431	019e2a2c-0e88-725f-a375-d0c1033b7e02	s1	default	failed	1778823990942	1778823997007	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-103a-74b2-ba46-858559c01e82	019e2a2c-1022-7091-8bbd-2df084dd2aaa	s1	default	failed	1778823991354	1778823997402	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-11c1-7458-b519-7e6010aedd99	019e2a2c-11a2-77d9-b232-03227413ab2d	s1	default	failed	1778823991746	1778823997817	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-131f-7147-9fd5-13acad1ba69f	019e2a2c-1308-710a-a349-dc3e482b7aee	s1	default	failed	1778823992095	1778823998162	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-1488-7394-ad62-2ffc0a1d9f05	019e2a2c-146d-7148-a9b2-8a7cb4aef396	s1	default	failed	1778823992456	1778823998528	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-0a66-72cc-acc2-2b38e9732db7	019e2a2c-0a14-72bc-93b7-db0e9832a320	s1	default	failed	1778823989862	1778823995958	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-1275-733b-bb56-857f285ce72c	019e2a2c-0a14-72bc-93b7-db0e9832a320	s1	default	failed	1778823991925	1778823995958	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-2229-701b-946e-afaefa21184f	019e2a2c-0a14-72bc-93b7-db0e9832a320	s1	default	failed	1778823995945	1778823995958	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-13f7-73f8-9d2b-1fb891c8cbc2	019e2a2c-0b91-77b0-8550-e808491fb484	s1	default	failed	1778823992311	1778823996352	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-152a-77fd-86bf-6c78837dcd43	019e2a2c-0d1e-7219-b020-6e619b701baf	s1	default	failed	1778823992618	1778823996658	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-1819-7088-99e0-308ae34694e0	019e2a2c-1022-7091-8bbd-2df084dd2aaa	s1	default	failed	1778823993369	1778823997402	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-1b11-76be-8332-9b5a1b4ec307	019e2a2c-1308-710a-a349-dc3e482b7aee	s1	default	failed	1778823994129	1778823998162	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-160a-701d-90bf-a935e875d6ae	019e2a2c-15ed-700f-ad86-93cbb396bb5b	s1	default	failed	1778823992842	1778823998910	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-23b4-73de-8251-7699f6040589	019e2a2c-0b91-77b0-8550-e808491fb484	s1	default	failed	1778823996340	1778823996352	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-1df6-701f-86b9-f4f75caea2a2	019e2a2c-15ed-700f-ad86-93cbb396bb5b	s1	default	failed	1778823994870	1778823998910	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-2643-744a-a5d0-b55a29239d97	019e2a2c-0e88-725f-a375-d0c1033b7e02	s1	default	failed	1778823996995	1778823997007	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-2970-700b-b0ad-41964181520b	019e2a2c-11a2-77d9-b232-03227413ab2d	s1	default	failed	1778823997808	1778823997817	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-2c3a-744b-b581-815e001ca08b	019e2a2c-146d-7148-a9b2-8a7cb4aef396	s1	default	failed	1778823998522	1778823998528	\N	HTTP request failed: fetch failed	3	\N
019e2a2e-eaa8-76fa-b138-a821a6afa13c	019e2a2e-e229-771b-8a5a-f6e0140daf90	s1	default	failed	1778824178345	1778824182377	\N	HTTP request failed: fetch failed	3	\N
019e2a2e-fa5d-7678-a6a3-721f4d6d269f	019e2a2e-e229-771b-8a5a-f6e0140daf90	s1	default	failed	1778824182365	1778824182377	\N	HTTP request failed: fetch failed	3	\N
019e2a2e-e552-74cb-b6e8-167d0b1d6441	019e2a2e-e538-71ad-ac4c-cd60944b1a66	s1	default	failed	1778824176978	1778824183037	\N	HTTP request failed: fetch failed	3	\N
019e2a2e-ed31-773a-8623-8a1a5abe497e	019e2a2e-e538-71ad-ac4c-cd60944b1a66	s1	default	failed	1778824178993	1778824183037	\N	HTTP request failed: fetch failed	3	\N
019e2ca5-9d4b-7413-9a46-31a0c774d5b4	019e2ca5-9cbf-7202-9f66-f28e316915f6	s1	default	completed	1778865511755	1778865512073	{"waited": 300}	\N	1	\N
019e2a2c-24e6-7097-a6f0-71f25e2a1216	019e2a2c-0d1e-7219-b020-6e619b701baf	s1	default	failed	1778823996646	1778823996658	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-2f1c-75f3-acfa-dfe937e6d857	019e2a2c-1766-711c-ba86-f012b9ed7d03	s1	default	failed	1778823999260	1778823999276	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-27cf-76ba-acf8-fb403fdde615	019e2a2c-1022-7091-8bbd-2df084dd2aaa	s1	default	failed	1778823997392	1778823997402	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-2ac7-7648-bf34-0b6a15fe2488	019e2a2c-1308-710a-a349-dc3e482b7aee	s1	default	failed	1778823998151	1778823998162	\N	HTTP request failed: fetch failed	3	\N
019e2a2e-fbe9-77db-b605-6940606cbfcf	019e2a2e-e3cc-772e-a956-dca340326f4e	s1	default	failed	1778824182761	1778824182773	\N	HTTP request failed: fetch failed	3	\N
019e2a2e-ec37-708e-a795-71b6495b5db6	019e2a2e-e3cc-772e-a956-dca340326f4e	s1	default	failed	1778824178744	1778824182773	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-1687-7708-a4a8-75e2d922025d	019e2a2c-0e88-725f-a375-d0c1033b7e02	s1	default	failed	1778823992967	1778823997007	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-19ad-71e9-9305-d5b7dc88fc56	019e2a2c-11a2-77d9-b232-03227413ab2d	s1	default	failed	1778823993773	1778823997817	\N	HTTP request failed: fetch failed	3	\N
019e2a2c-1c75-739e-b74d-4f77918f4ec6	019e2a2c-146d-7148-a9b2-8a7cb4aef396	s1	default	failed	1778823994485	1778823998528	\N	HTTP request failed: fetch failed	3	\N
019e2a2e-e294-7053-b815-a74002c5a3c3	019e2a2e-e229-771b-8a5a-f6e0140daf90	s1	default	failed	1778824176276	1778824182377	\N	HTTP request failed: fetch failed	3	\N
019e2a2e-fcf1-72e0-af44-04519370946b	019e2a2e-e538-71ad-ac4c-cd60944b1a66	s1	default	failed	1778824183025	1778824183037	\N	HTTP request failed: fetch failed	3	\N
019e2ca2-3bac-7356-b81e-8f561e1147c0	019e2ca2-3ac5-7431-9573-3840e7cc190b	s1	default	completed	1778865290156	1778865290495	{"waited": 300}	\N	1	\N
\.


--
-- Data for Name: strategic_goals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.strategic_goals (id, workspace_id, business_id, parent_goal_id, title, description, status, horizon, target_date, progress, key_results, owners, tags, completed_at, created_at, updated_at) FROM stdin;
019e2a13-9e30-7579-bf24-d820ee2fc53f	default	019e2a13-9dde-742c-b38a-3ad3b0afdde4	\N	Reach 250K MRR by end of Q2 2026	Drive revenue growth through mid-market expansion, annual plan conversions, and reduced churn.	active	quarter	1782883189214	0.74	[{"kr": "Close 8 new mid-market accounts", "target": 8, "current": 5}, {"kr": "Convert 100 monthly subs to annual", "target": 100, "current": 68}, {"kr": "Reduce churn to <2%", "target": 0.02, "current": 0.028}]	{ceo,vp-sales}	{revenue,growth,q2-2026}	\N	1777612789214	1778735989214
019e2a13-9e30-7579-bf24-dc43977e98cf	default	019e2a13-9dde-742c-b38a-3ad3b0afdde4	\N	Ship AI-native v2 product by Q3 2026	Rebuild core user experience around AI workflows, autonomous briefings, and proactive insights.	active	annual	1790745589214	0.31	[{"kr": "Launch AI briefings to 100% of accounts", "target": 1, "current": 0.15}, {"kr": "Achieve 70% weekly active usage of AI features", "target": 0.7, "current": 0.22}, {"kr": "NPS score ≥80 post-launch", "target": 80, "current": null}]	{cto,vp-product}	{product,ai,q3-2026}	\N	1776230389214	1778390389214
019e2a13-9e30-7579-bf24-e13a5f3a250c	default	019e2a13-9dde-742c-b38a-3ad3b0afdde4	\N	Establish first strategic partnership by Q2 2026	Close a go-to-market partnership with a complementary data or analytics platform.	active	quarter	1782883189214	0.4	[{"kr": "Sign partnership agreement with Gamma Analytics", "target": 1, "current": 0}, {"kr": "Generate 50 qualified leads via partner channel", "target": 50, "current": 0}]	{ceo,vp-partnerships}	{partnerships,q2-2026}	\N	1777958389214	1778649589214
\.


--
-- Data for Name: task_traces; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.task_traces (id, workspace_id, trace_id, run_id, step_id, step_type, status, attempt, started_at, completed_at, duration_ms, output, error, created_at) FROM stdin;
019e2a1a-455a-714b-b9f2-64524c624ff0	default	019e2a18-c41a-77db-b5b7-82582a84d13d	019e2a18-c41a-77db-b5b7-7d0605b1d852	step1	delay	running	1	1778822825306	\N	\N	\N	\N	1778822825306
019e2a1f-2e51-7329-ba46-8306117746ec	default	019e2a1f-2dd0-7016-b332-380d9917ae83	019e2a1f-2dd0-7016-b332-35d7f32f18df	step1	delay	completed	1	1778823147090	1778823147140	42	{"type": "delay", "skipped": true}	\N	1778823147090
019e2a1f-dabf-75c3-9612-865ed222d3b6	default	019e2a1f-da6a-7695-8f18-5d600625aa81	019e2a1f-da6a-7695-8f18-5986320d4ebc	step1	http	completed	1	1778823191231	1778823191268	27	{"type": "http", "skipped": true}	\N	1778823191231
019e2a27-e751-70be-ad65-947ded281a21	default	019e2a27-e6f5-70fd-a796-5fe06ab1981c	019e2a27-e6f5-70fd-a796-5b4e43099e1a	s1	delay	completed	1	1778823718737	1778823718794	49	{"type": "delay", "skipped": true}	\N	1778823718737
019e2a27-e89b-74df-9e57-b8390b5bee67	default	019e2a27-e87f-7203-9c33-ad596cbab721	019e2a27-e87f-7203-9c33-a97d8d196838	s1	delay	completed	1	1778823719067	1778823719112	30	{"type": "delay", "skipped": true}	\N	1778823719067
019e2a27-ea1c-7199-9afa-dcce7288eb98	default	019e2a27-e9fb-75ff-8604-6a20f882bd59	019e2a27-e9fb-75ff-8604-662549188e42	s1	delay	completed	1	1778823719452	1778823719499	38	{"type": "delay", "skipped": true}	\N	1778823719452
019e2a27-eb88-729c-91bf-d9aa007be6bf	default	019e2a27-eb6c-7798-9e77-b58d28604493	019e2a27-eb6c-7798-9e77-b3cd111301dc	s1	delay	completed	1	1778823719816	1778823719855	31	{"type": "delay", "skipped": true}	\N	1778823719816
019e2a27-ecec-767a-af86-a6cbbf04e45d	default	019e2a27-ecd1-734c-baed-c05113a4cb53	019e2a27-ecd1-734c-baed-bf50bb7a3ebe	s1	delay	completed	1	1778823720172	1778823720211	32	{"type": "delay", "skipped": true}	\N	1778823720172
019e2a27-ee6f-709d-8fd9-54e82a0fb5d8	default	019e2a27-ee55-716e-b73e-489cdb9554a8	019e2a27-ee55-716e-b73e-47dff9244354	s1	delay	completed	1	1778823720559	1778823720596	30	{"type": "delay", "skipped": true}	\N	1778823720559
019e2a27-eff4-7248-92ad-2355cff84c33	default	019e2a27-efd8-77bb-8d9b-7562dd76c055	019e2a27-efd8-77bb-8d9b-728ff860c105	s1	delay	completed	1	1778823720948	1778823720982	26	{"type": "delay", "skipped": true}	\N	1778823720948
019e2a27-f14c-752e-b468-2081e056e345	default	019e2a27-f135-763e-89f1-a3a33a781ce2	019e2a27-f135-763e-89f1-9cfbf82a21c9	s1	delay	completed	1	1778823721292	1778823721352	52	{"type": "delay", "skipped": true}	\N	1778823721292
019e2a27-f2cb-761b-866c-e1e04386c6a0	default	019e2a27-f2b4-75ff-89f8-501eba7413bd	019e2a27-f2b4-75ff-89f8-4c68f77711fe	s1	delay	completed	1	1778823721675	1778823721729	46	{"type": "delay", "skipped": true}	\N	1778823721675
019e2a27-f43a-72ad-973e-2f4ccbe40650	default	019e2a27-f420-7482-a357-d307e0be459a	019e2a27-f420-7482-a357-cc9aca9a86a0	s1	delay	completed	1	1778823722042	1778823722084	26	{"type": "delay", "skipped": true}	\N	1778823722042
019e2a28-6752-773c-8d4e-c409dd226839	default	019e2a28-6728-71b9-aa98-5a880110fecb	019e2a28-6728-71b9-aa98-5541ae7d8827	s1	http	completed	1	1778823751506	1778823751547	35	{"type": "http", "skipped": true}	\N	1778823751506
019e2a28-68d1-7340-9df0-dc315e2008e3	default	019e2a28-68b9-7473-b384-9ce725ac3917	019e2a28-68b9-7473-b384-992b3f8dae23	s1	http	completed	1	1778823751889	1778823751942	44	{"type": "http", "skipped": true}	\N	1778823751889
019e2a28-6a37-7071-b991-14dccbe15d8e	default	019e2a28-6a24-70ed-a172-17b01950a6d8	019e2a28-6a24-70ed-a172-134d40f5840a	s1	http	completed	1	1778823752247	1778823752280	26	{"type": "http", "skipped": true}	\N	1778823752247
019e2a28-6bc3-7678-a59c-893cd5cc1791	default	019e2a28-6ba8-764a-8dab-d389e1bb96b1	019e2a28-6ba8-764a-8dab-cc0cd36719c5	s1	http	completed	1	1778823752643	1778823752689	37	{"type": "http", "skipped": true}	\N	1778823752643
019e2a28-6d53-727d-b449-bd18ccbff901	default	019e2a28-6d38-77fa-8f1e-d72e5d8f5586	019e2a28-6d38-77fa-8f1e-d39c173ef939	s1	http	completed	1	1778823753043	1778823753104	50	{"type": "http", "skipped": true}	\N	1778823753043
019e2a28-6ed8-715b-a3cd-db732f30c22d	default	019e2a28-6eba-756e-8b38-d3ee2efaf506	019e2a28-6eba-756e-8b38-cd5ab01cc825	s1	http	completed	1	1778823753432	1778823753470	30	{"type": "http", "skipped": true}	\N	1778823753432
019e2a28-7036-7407-a842-df4a8147c699	default	019e2a28-7015-70d4-a603-740c0f7040fc	019e2a28-7015-70d4-a603-728242725f76	s1	http	completed	1	1778823753782	1778823753823	32	{"type": "http", "skipped": true}	\N	1778823753782
019e2a28-71a3-705a-a7dd-c2147b251009	default	019e2a28-718b-76db-a7ae-ede6dac1c055	019e2a28-718b-76db-a7ae-eae07ef816c0	s1	http	completed	1	1778823754147	1778823754208	52	{"type": "http", "skipped": true}	\N	1778823754147
019e2a28-7338-77d2-9855-736467f56e17	default	019e2a28-730d-7229-84d8-c10e6812af0a	019e2a28-730d-7229-84d8-bf4667b361ae	s1	http	completed	1	1778823754552	1778823754592	31	{"type": "http", "skipped": true}	\N	1778823754552
019e2a28-749c-72c2-94fd-ad4ea3d0ef52	default	019e2a28-7482-7564-8317-6bcbb6775255	019e2a28-7482-7564-8317-65cfabf5f758	s1	http	completed	1	1778823754908	1778823754943	27	{"type": "http", "skipped": true}	\N	1778823754908
019e2a2c-0a66-72cc-acc2-2f9570ca9cc2	default	019e2a2c-0a14-72bc-93b7-dd7d17623973	019e2a2c-0a14-72bc-93b7-db0e9832a320	s1	http	retrying	1	1778823989863	1778823989906	44	\N	HTTP request failed: fetch failed	1778823989863
019e2a2c-0bf0-7252-aa8f-0b8b34891dc2	default	019e2a2c-0b91-77b0-8550-ef199b37d9c9	019e2a2c-0b91-77b0-8550-e808491fb484	s1	http	retrying	1	1778823990256	1778823990299	43	\N	HTTP request failed: fetch failed	1778823990256
019e2a2c-0d39-73d9-935c-dc09f700b79e	default	019e2a2c-0d1e-7219-b020-70ec11d66e58	019e2a2c-0d1e-7219-b020-6e619b701baf	s1	http	retrying	1	1778823990585	1778823990598	13	\N	HTTP request failed: fetch failed	1778823990585
019e2a2c-0e9e-73de-8c5e-f1a9f314287c	default	019e2a2c-0e88-725f-a375-d6a98359d140	019e2a2c-0e88-725f-a375-d0c1033b7e02	s1	http	retrying	1	1778823990942	1778823990954	12	\N	HTTP request failed: fetch failed	1778823990942
019e2a2c-103a-74b2-ba46-8944c2928422	default	019e2a2c-1022-7091-8bbd-3186f9ca61e7	019e2a2c-1022-7091-8bbd-2df084dd2aaa	s1	http	retrying	1	1778823991354	1778823991365	11	\N	HTTP request failed: fetch failed	1778823991354
019e2a2c-11c2-713a-9724-9a8a2905917e	default	019e2a2c-11a2-77d9-b232-078b3add23ba	019e2a2c-11a2-77d9-b232-03227413ab2d	s1	http	retrying	1	1778823991746	1778823991757	11	\N	HTTP request failed: fetch failed	1778823991746
019e2a2c-1275-733b-bb56-89f5033cd122	default	019e2a2c-0a14-72bc-93b7-dd7d17623973	019e2a2c-0a14-72bc-93b7-db0e9832a320	s1	http	retrying	2	1778823991925	1778823991937	12	\N	HTTP request failed: fetch failed	1778823991925
019e2a2c-131f-7147-9fd5-14c6291fa417	default	019e2a2c-1308-710a-a349-e2ffebeec275	019e2a2c-1308-710a-a349-dc3e482b7aee	s1	http	retrying	1	1778823992095	1778823992113	18	\N	HTTP request failed: fetch failed	1778823992095
019e2a2c-13f8-75cb-9a59-58ed024528dd	default	019e2a2c-0b91-77b0-8550-ef199b37d9c9	019e2a2c-0b91-77b0-8550-e808491fb484	s1	http	retrying	2	1778823992312	1778823992329	18	\N	HTTP request failed: fetch failed	1778823992312
019e2a2c-1488-7394-ad62-32ed2a85d77b	default	019e2a2c-146d-7148-a9b2-8d6e837db21c	019e2a2c-146d-7148-a9b2-8a7cb4aef396	s1	http	retrying	1	1778823992456	1778823992467	11	\N	HTTP request failed: fetch failed	1778823992456
019e2a2c-1687-7708-a4a8-7bcb5d025a0b	default	019e2a2c-0e88-725f-a375-d6a98359d140	019e2a2c-0e88-725f-a375-d0c1033b7e02	s1	http	retrying	2	1778823992967	1778823992983	16	\N	HTTP request failed: fetch failed	1778823992967
019e2a2c-1781-714d-8b49-67d4a2370e74	default	019e2a2c-1766-711c-ba86-f58d40675229	019e2a2c-1766-711c-ba86-f012b9ed7d03	s1	http	retrying	1	1778823993217	1778823993228	11	\N	HTTP request failed: fetch failed	1778823993217
019e2a2c-19ad-71e9-9305-db4e8e4af71f	default	019e2a2c-11a2-77d9-b232-078b3add23ba	019e2a2c-11a2-77d9-b232-03227413ab2d	s1	http	retrying	2	1778823993773	1778823993789	16	\N	HTTP request failed: fetch failed	1778823993773
019e2a2c-1c75-739e-b74d-52aa38b59b45	default	019e2a2c-146d-7148-a9b2-8d6e837db21c	019e2a2c-146d-7148-a9b2-8a7cb4aef396	s1	http	retrying	2	1778823994485	1778823994504	19	\N	HTTP request failed: fetch failed	1778823994485
019e2a2c-1f61-75e1-a355-58e10a6b4a08	default	019e2a2c-1766-711c-ba86-f58d40675229	019e2a2c-1766-711c-ba86-f012b9ed7d03	s1	http	retrying	2	1778823995233	1778823995250	17	\N	HTTP request failed: fetch failed	1778823995233
019e2a2c-23b4-73de-8251-7ae859ecf737	default	019e2a2c-0b91-77b0-8550-ef199b37d9c9	019e2a2c-0b91-77b0-8550-e808491fb484	s1	http	failed	3	1778823996340	1778823996356	16	\N	HTTP request failed: fetch failed	1778823996340
019e2a2c-2643-744a-a5d0-bb0b7f6b4c5b	default	019e2a2c-0e88-725f-a375-d6a98359d140	019e2a2c-0e88-725f-a375-d0c1033b7e02	s1	http	failed	3	1778823996995	1778823997011	16	\N	HTTP request failed: fetch failed	1778823996995
019e2a2c-2970-700b-b0ad-4423ec268edf	default	019e2a2c-11a2-77d9-b232-078b3add23ba	019e2a2c-11a2-77d9-b232-03227413ab2d	s1	http	failed	3	1778823997808	1778823997820	12	\N	HTTP request failed: fetch failed	1778823997808
019e2a2c-2c3a-744b-b581-87219fc2e7b9	default	019e2a2c-146d-7148-a9b2-8d6e837db21c	019e2a2c-146d-7148-a9b2-8a7cb4aef396	s1	http	failed	3	1778823998522	1778823998531	9	\N	HTTP request failed: fetch failed	1778823998522
019e2a2c-152a-77fd-86bf-7372d8f01b9b	default	019e2a2c-0d1e-7219-b020-70ec11d66e58	019e2a2c-0d1e-7219-b020-6e619b701baf	s1	http	retrying	2	1778823992618	1778823992636	18	\N	HTTP request failed: fetch failed	1778823992618
019e2a2c-160a-701d-90bf-ae611f1564ee	default	019e2a2c-15ed-700f-ad86-94cb71e730b7	019e2a2c-15ed-700f-ad86-93cbb396bb5b	s1	http	retrying	1	1778823992842	1778823992853	11	\N	HTTP request failed: fetch failed	1778823992842
019e2a2c-1819-7088-99e0-367208fc4197	default	019e2a2c-1022-7091-8bbd-3186f9ca61e7	019e2a2c-1022-7091-8bbd-2df084dd2aaa	s1	http	retrying	2	1778823993369	1778823993384	15	\N	HTTP request failed: fetch failed	1778823993369
019e2a2c-1b11-76be-8332-9c310610ca94	default	019e2a2c-1308-710a-a349-e2ffebeec275	019e2a2c-1308-710a-a349-dc3e482b7aee	s1	http	retrying	2	1778823994129	1778823994144	15	\N	HTTP request failed: fetch failed	1778823994129
019e2a2c-1df6-701f-86b9-f99279958d02	default	019e2a2c-15ed-700f-ad86-94cb71e730b7	019e2a2c-15ed-700f-ad86-93cbb396bb5b	s1	http	retrying	2	1778823994870	1778823994887	17	\N	HTTP request failed: fetch failed	1778823994870
019e2a2c-2229-701b-946e-b1128da9d0ae	default	019e2a2c-0a14-72bc-93b7-dd7d17623973	019e2a2c-0a14-72bc-93b7-db0e9832a320	s1	http	failed	3	1778823995945	1778823995961	16	\N	HTTP request failed: fetch failed	1778823995945
019e2a2c-24e6-7097-a6f0-775368528d5f	default	019e2a2c-0d1e-7219-b020-70ec11d66e58	019e2a2c-0d1e-7219-b020-6e619b701baf	s1	http	failed	3	1778823996646	1778823996661	15	\N	HTTP request failed: fetch failed	1778823996646
019e2a2c-27d0-704d-ae7b-e20cc650a796	default	019e2a2c-1022-7091-8bbd-3186f9ca61e7	019e2a2c-1022-7091-8bbd-2df084dd2aaa	s1	http	failed	3	1778823997392	1778823997406	14	\N	HTTP request failed: fetch failed	1778823997392
019e2a2c-2ac7-7648-bf34-0feb264f09c8	default	019e2a2c-1308-710a-a349-e2ffebeec275	019e2a2c-1308-710a-a349-dc3e482b7aee	s1	http	failed	3	1778823998151	1778823998166	15	\N	HTTP request failed: fetch failed	1778823998151
019e2a2c-2db3-75de-80b3-ecd7e836df65	default	019e2a2c-15ed-700f-ad86-94cb71e730b7	019e2a2c-15ed-700f-ad86-93cbb396bb5b	s1	http	failed	3	1778823998899	1778823998915	16	\N	HTTP request failed: fetch failed	1778823998899
019e2a2c-2f1c-75f3-acfa-e202aada7cf2	default	019e2a2c-1766-711c-ba86-f58d40675229	019e2a2c-1766-711c-ba86-f012b9ed7d03	s1	http	failed	3	1778823999260	1778823999281	21	\N	HTTP request failed: fetch failed	1778823999260
019e2a2e-e294-7053-b815-aa9c58d0b896	default	019e2a2e-e22a-75d9-8934-8b2f4f063032	019e2a2e-e229-771b-8a5a-f6e0140daf90	s1	http	retrying	1	1778824176276	1778824176335	59	\N	HTTP request failed: fetch failed	1778824176276
019e2a2e-e42f-71eb-853e-bc1400b6ea64	default	019e2a2e-e3cc-772e-a956-e2ba924719bb	019e2a2e-e3cc-772e-a956-dca340326f4e	s1	http	retrying	1	1778824176687	1778824176731	44	\N	HTTP request failed: fetch failed	1778824176687
019e2a2e-e552-74cb-b6e8-1b488a2b403d	default	019e2a2e-e538-71ad-ac4c-d27e3caf9d21	019e2a2e-e538-71ad-ac4c-cd60944b1a66	s1	http	retrying	1	1778824176978	1778824176989	11	\N	HTTP request failed: fetch failed	1778824176978
019e2a2e-eaa9-703c-980a-93bec195226a	default	019e2a2e-e22a-75d9-8934-8b2f4f063032	019e2a2e-e229-771b-8a5a-f6e0140daf90	s1	http	retrying	2	1778824178345	1778824178361	16	\N	HTTP request failed: fetch failed	1778824178345
019e2a2e-ec38-7590-abb4-3c6858b3678f	default	019e2a2e-e3cc-772e-a956-e2ba924719bb	019e2a2e-e3cc-772e-a956-dca340326f4e	s1	http	retrying	2	1778824178744	1778824178754	10	\N	HTTP request failed: fetch failed	1778824178744
019e2a2e-ed31-773a-8623-8e40ff70642b	default	019e2a2e-e538-71ad-ac4c-d27e3caf9d21	019e2a2e-e538-71ad-ac4c-cd60944b1a66	s1	http	retrying	2	1778824178993	1778824179009	16	\N	HTTP request failed: fetch failed	1778824178993
019e2a2e-fa5d-7678-a6a3-76212b9140d4	default	019e2a2e-e22a-75d9-8934-8b2f4f063032	019e2a2e-e229-771b-8a5a-f6e0140daf90	s1	http	failed	3	1778824182365	1778824182381	16	\N	HTTP request failed: fetch failed	1778824182365
019e2a2e-fbea-760a-ab17-46fae7eb427b	default	019e2a2e-e3cc-772e-a956-e2ba924719bb	019e2a2e-e3cc-772e-a956-dca340326f4e	s1	http	failed	3	1778824182762	1778824182778	17	\N	HTTP request failed: fetch failed	1778824182762
019e2a2e-fcf1-72e0-af44-0a81f6938b53	default	019e2a2e-e538-71ad-ac4c-d27e3caf9d21	019e2a2e-e538-71ad-ac4c-cd60944b1a66	s1	http	failed	3	1778824183025	1778824183042	17	\N	HTTP request failed: fetch failed	1778824183025
019e2ca2-3bac-7356-b81e-9206342dc4bd	default	019e2ca2-3ac5-7431-9573-3f00dc49d731	019e2ca2-3ac5-7431-9573-3840e7cc190b	s1	delay	completed	1	1778865290156	1778865290509	339	{"waited": 300}	\N	1778865290156
019e2ca5-9d4b-7413-9a46-3495939e4d1b	default	019e2ca5-9cbf-7202-9f66-f5ef00648282	019e2ca5-9cbf-7202-9f66-f28e316915f6	s1	delay	completed	1	1778865511755	1778865512091	318	{"waited": 300}	\N	1778865511755
\.


--
-- Data for Name: webhook_deliveries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.webhook_deliveries (id, webhook_id, workspace_id, event_type, payload, status, run_id, error, created_at) FROM stdin;
\.


--
-- Data for Name: webhooks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.webhooks (id, workspace_id, name, secret, events, target_url, workflow_id, active, call_count, last_called_at, created_at, updated_at) FROM stdin;
019e2a19-2f56-756e-a164-d83d3882fe72	default	RC1 Test Webhook	whsec_58f174a9afb2355864059445b19f987340fdc40549a32a950ad6c236b18acff1	{workflow.completed}	\N	\N	t	0	\N	1778822754134	1778822754134
\.


--
-- Data for Name: worker_traces; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.worker_traces (id, workspace_id, trace_id, worker_id, worker_name, queue_name, event, heap_used_mb, rss_mem_mb, active_jobs, processed_jobs, created_at) FROM stdin;
\.


--
-- Data for Name: workflow_definitions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.workflow_definitions (id, workspace_id, name, description, version, steps, triggers, retry_policy, timeout, tags, is_active, created_at, updated_at) FROM stdin;
019e2a13-9ddf-73e1-ac5c-66108b66008e	default	Daily Executive Briefing	Aggregates signals from all sources and generates a prioritized executive briefing	3	[{"id": "fetch-signals", "type": "fetch", "config": {"sources": ["events", "risks", "opportunities"]}}, {"id": "rank-items", "type": "ai", "config": {"model": "claude-3-5-sonnet-20241022", "temperature": 0.3}}, {"id": "send-briefing", "type": "notify", "config": {"channels": ["email", "slack"]}}]	[{"cron": "0 8 * * 1-5", "type": "schedule", "timezone": "America/New_York"}]	{"backoffMs": 5000, "maxAttempts": 3, "backoffMultiplier": 2}	600000	{briefing,daily,executive}	t	1776662389214	1778735989214
019e2a13-9ddf-73e1-ac5c-6957b2448768	default	Opportunity Scanner	Scans business metrics and market signals to identify new opportunities	2	[{"id": "ingest-metrics", "type": "fetch", "config": {"sources": ["businesses", "events"]}}, {"id": "score-signals", "type": "ai", "config": {"model": "claude-3-5-haiku-20241022", "temperature": 0.5}}, {"id": "create-opps", "type": "write", "config": {"table": "opportunities"}}]	[{"cron": "0 6 * * *", "type": "schedule", "timezone": "UTC"}]	{"backoffMs": 3000, "maxAttempts": 2, "backoffMultiplier": 1.5}	300000	{opportunities,scanning,ai}	t	1777526389214	1778649589214
019e2a13-9ddf-73e1-ac5c-6c67864f856f	default	Risk Monitor	Continuously monitors risk indicators and escalates critical issues	1	[{"id": "fetch-risks", "type": "fetch", "config": {"sources": ["risks", "events"]}}, {"id": "evaluate", "type": "ai", "config": {"model": "claude-3-5-sonnet-20241022", "temperature": 0.2}}, {"id": "alert-if-high", "type": "conditional", "config": {"threshold": 0.7}}]	[{"cron": "*/30 * * * *", "type": "schedule", "timezone": "UTC"}]	{"backoffMs": 2000, "maxAttempts": 3, "backoffMultiplier": 2}	120000	{risk,monitoring,alerts}	t	1777958389214	1778563189214
019e2a18-c402-7338-bdab-25577b1d9897	default	RC1 Test Workflow	End-to-end RC1 validation workflow	1	[{"id": "step1", "name": "Wait", "type": "delay", "config": {"waitMs": 100}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	30000	{rc1,test}	t	1778822726658	1778822726658
019e2a18-c438-732b-88c0-38e5736ffc82	default	RC1 Fail Workflow	\N	1	[{"id": "step1", "name": "Fail HTTP", "type": "http", "config": {"url": "http://localhost:9999/fail", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	5000	{rc1,fail-test}	t	1778822726712	1778822726712
019e2a27-3cdc-706c-91f4-bb8857cd5643	default	LR-Success-1	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 500}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823675100	1778823675100
019e2a27-3f27-77c5-9da2-f57decae13cc	default	LR-Success-2	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 500}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823675687	1778823675687
019e2a27-4106-721b-92d2-97fe0ddf7f95	default	LR-Success-3	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 500}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823676166	1778823676166
019e2a27-42d2-75bb-a108-52b8f7cf3db2	default	LR-Success-4	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 500}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823676626	1778823676626
019e2a27-44b4-77e8-99f0-70976a7f6c2e	default	LR-Success-5	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 500}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823677108	1778823677108
019e2a27-4691-7580-b095-5bff1705d7c0	default	LR-Success-6	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 500}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823677585	1778823677585
019e2a27-4883-7478-a00c-d495ac7d034d	default	LR-Success-7	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 500}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823678083	1778823678083
019e2a27-4a86-7539-a0bf-1ae094612c05	default	LR-Success-8	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 500}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823678598	1778823678598
019e2a27-4c54-7731-8692-b6fc0657d9c2	default	LR-Success-9	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 500}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823679060	1778823679060
019e2a27-4e2b-73f7-a636-083b11eec6b9	default	LR-Success-10	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 500}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823679531	1778823679531
019e2a27-5012-709b-9c12-1e95614e0999	default	LR-Fail-1	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://localhost:9999/fail", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,fail}	t	1778823680018	1778823680018
019e2a27-51fc-7333-bea7-94139848d850	default	LR-Fail-2	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://localhost:9999/fail", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,fail}	t	1778823680508	1778823680508
019e2a27-53e0-70d0-b26d-5c32476708a0	default	LR-Fail-3	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://localhost:9999/fail", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,fail}	t	1778823680992	1778823680992
019e2a27-55b7-715b-b1c5-1cd559a6c80b	default	LR-Fail-4	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://localhost:9999/fail", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,fail}	t	1778823681463	1778823681463
019e2a27-5793-725e-a58d-1767a7b979c1	default	LR-Fail-5	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://localhost:9999/fail", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,fail}	t	1778823681939	1778823681939
019e2a27-598f-7220-bdbc-53904b21c4bc	default	LR-DLQ-1	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://127.0.0.1:19999/dead", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,dlq}	t	1778823682447	1778823682447
019e2a27-5b61-7698-a43e-00be2612f126	default	LR-DLQ-2	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://127.0.0.1:19999/dead", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,dlq}	t	1778823682913	1778823682913
019e2a27-5d26-7040-b4ff-5e4d5a310bb9	default	LR-DLQ-3	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://127.0.0.1:19999/dead", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,dlq}	t	1778823683366	1778823683366
019e2a27-5ef3-758f-bc29-aff9bc3d853e	default	LR-DLQ-4	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://127.0.0.1:19999/dead", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,dlq}	t	1778823683827	1778823683827
019e2a27-60cf-70ff-ac3b-e4c82f68b177	default	LR-DLQ-5	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://127.0.0.1:19999/dead", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,dlq}	t	1778823684303	1778823684303
019e2a27-7a3f-7674-be12-b3ed396e085e	default	Debug-Test	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 100}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{debug}	t	1778823690815	1778823690815
019e2a27-ab53-75a0-b3f8-7df80437fe20	default	LR-Success-1	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 300}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823703379	1778823703379
019e2a27-ace7-7569-bce8-75cff7a4406a	default	LR-Success-2	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 300}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823703783	1778823703783
019e2a27-ae58-739c-8835-344a06d2d580	default	LR-Success-3	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 300}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823704152	1778823704152
019e2a27-afb5-76bc-ae87-988dd0d36522	default	LR-Success-4	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 300}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823704501	1778823704501
019e2a27-b119-773a-8bc3-d9e1a120f50e	default	LR-Success-5	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 300}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823704857	1778823704857
019e2a27-b27e-72dc-b59c-c332d97f8734	default	LR-Success-6	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 300}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823705214	1778823705214
019e2a27-b3ed-75dc-89e0-b9645a5bf30d	default	LR-Success-7	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 300}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823705581	1778823705581
019e2a27-b56e-737d-8753-a657760aafa3	default	LR-Success-8	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 300}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823705966	1778823705966
019e2a27-b6de-7236-ab35-c399c2e49629	default	LR-Success-9	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 300}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823706334	1778823706334
019e2a27-b86c-763a-8a50-a98db01c2b89	default	LR-Success-10	\N	1	[{"id": "s1", "name": "Delay", "type": "delay", "config": {"waitMs": 300}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,success}	t	1778823706732	1778823706732
019e2a27-b9e2-7329-a93c-659f7ab8f611	default	LR-Fail-1	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://localhost:9999/fail", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,fail}	t	1778823707106	1778823707106
019e2a27-bb47-705a-8bbc-f0feeb2f3bfb	default	LR-Fail-2	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://localhost:9999/fail", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,fail}	t	1778823707463	1778823707463
019e2a27-bcad-772b-b156-20bb6d6a0328	default	LR-Fail-3	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://localhost:9999/fail", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,fail}	t	1778823707821	1778823707821
019e2a27-be13-7188-8c61-86b20a9912d5	default	LR-Fail-4	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://localhost:9999/fail", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,fail}	t	1778823708179	1778823708179
019e2a27-bf91-717d-82f9-b529c3088dfe	default	LR-Fail-5	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://localhost:9999/fail", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,fail}	t	1778823708561	1778823708561
019e2a27-c102-7520-a5d9-ac2632a345a6	default	LR-DLQ-1	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://127.0.0.1:19999/dead", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,dlq}	t	1778823708930	1778823708930
019e2a27-c274-71c0-9bf3-268e44d35639	default	LR-DLQ-2	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://127.0.0.1:19999/dead", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,dlq}	t	1778823709300	1778823709300
019e2a27-c3fa-7446-aedb-25dbcb892a9d	default	LR-DLQ-3	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://127.0.0.1:19999/dead", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,dlq}	t	1778823709690	1778823709690
019e2a27-c56a-70e9-85ea-7b99dd6a1be9	default	LR-DLQ-4	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://127.0.0.1:19999/dead", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,dlq}	t	1778823710058	1778823710058
019e2a27-c6ec-72eb-a1a3-96a31c05aeb4	default	LR-DLQ-5	\N	1	[{"id": "s1", "name": "BadHTTP", "type": "http", "config": {"url": "http://127.0.0.1:19999/dead", "method": "GET"}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{longrun,dlq}	t	1778823710444	1778823710444
019e2ca2-1599-758d-84cd-48f8c0b6cb17	default	DR-CANARY-SHOULD-NOT-EXIST-AFTER-RESTORE	\N	1	[{"id": "s1", "name": "Canary", "type": "delay", "config": {"waitMs": 100}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{dr-canary}	t	1778865280409	1778865280409
019e2ca5-7bb8-7126-b3bd-e26578c1cdb0	default	DR-CANARY-SHOULD-NOT-EXIST-AFTER-RESTORE	\N	1	[{"id": "s1", "name": "Canary", "type": "delay", "config": {"waitMs": 100}, "timeout": null, "dependsOn": [], "onFailure": "fail"}]	[]	{"backoffMs": 1000, "maxAttempts": 3, "maxBackoffMs": 30000, "backoffMultiplier": 2}	300000	{dr-canary}	t	1778865503160	1778865503160
\.


--
-- Data for Name: workflow_runs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.workflow_runs (id, workflow_id, workspace_id, status, triggered_by, triggered_at, started_at, completed_at, failed_at, error_message, context, attempt, parent_run_id, checkpoint_at, checkpoint_state, trace_id) FROM stdin;
019e2a18-c41a-77db-b5b7-7d0605b1d852	019e2a18-c402-7338-bdab-25577b1d9897	default	pending	rc1-test	1778822726682	1778822825083	\N	1778822825338	\N	{"test": true}	2	\N	\N	\N	019e2a18-c41a-77db-b5b7-82582a84d13d
019e2a1f-2dd0-7016-b332-35d7f32f18df	019e2a18-c402-7338-bdab-25577b1d9897	default	completed	rc1-test-v2	1778823146960	1778823147056	1778823147167	\N	\N	{"rc1": true}	1	\N	\N	\N	019e2a1f-2dd0-7016-b332-380d9917ae83
019e2a2c-15ed-700f-ad86-93cbb396bb5b	019e2a27-c56a-70e9-85ea-7b99dd6a1be9	default	pending	api	1778823992813	1778823992830	\N	1778823998921	\N	{}	2	\N	\N	\N	019e2a2c-15ed-700f-ad86-94cb71e730b7
019e2a2c-1766-711c-ba86-f012b9ed7d03	019e2a27-c6ec-72eb-a1a3-96a31c05aeb4	default	pending	api	1778823993190	1778823993206	\N	1778823999289	\N	{}	2	\N	\N	\N	019e2a2c-1766-711c-ba86-f58d40675229
019e2a1f-da6a-7695-8f18-5986320d4ebc	019e2a18-c438-732b-88c0-38e5736ffc82	default	completed	rc1-fail-test	1778823191146	1778823191173	1778823191295	\N	\N	{"shouldFail": true}	1	\N	\N	\N	019e2a1f-da6a-7695-8f18-5d600625aa81
019e2a2c-0a14-72bc-93b7-db0e9832a320	019e2a27-b9e2-7329-a93c-659f7ab8f611	default	pending	api	1778823989780	1778823989821	\N	1778823995975	\N	{}	2	\N	\N	\N	019e2a2c-0a14-72bc-93b7-dd7d17623973
019e2a2c-0b91-77b0-8550-e808491fb484	019e2a27-bb47-705a-8bbc-f0feeb2f3bfb	default	pending	api	1778823990161	1778823990205	\N	1778823996371	\N	{}	2	\N	\N	\N	019e2a2c-0b91-77b0-8550-ef199b37d9c9
019e2a27-e6f5-70fd-a796-5b4e43099e1a	019e2a27-ab53-75a0-b3f8-7df80437fe20	default	completed	api	1778823718645	1778823718696	1778823718825	\N	\N	{}	1	\N	\N	\N	019e2a27-e6f5-70fd-a796-5fe06ab1981c
019e2a2c-0d1e-7219-b020-6e619b701baf	019e2a27-bcad-772b-b156-20bb6d6a0328	default	pending	api	1778823990558	1778823990573	\N	1778823996668	\N	{}	2	\N	\N	\N	019e2a2c-0d1e-7219-b020-70ec11d66e58
019e2a2c-0e88-725f-a375-d0c1033b7e02	019e2a27-be13-7188-8c61-86b20a9912d5	default	pending	api	1778823990920	1778823990933	\N	1778823997017	\N	{}	2	\N	\N	\N	019e2a2c-0e88-725f-a375-d6a98359d140
019e2a27-e87f-7203-9c33-a97d8d196838	019e2a27-ace7-7569-bce8-75cff7a4406a	default	completed	api	1778823719039	1778823719054	1778823719128	\N	\N	{}	1	\N	\N	\N	019e2a27-e87f-7203-9c33-ad596cbab721
019e2a2c-1022-7091-8bbd-2df084dd2aaa	019e2a27-bf91-717d-82f9-b529c3088dfe	default	pending	api	1778823991330	1778823991343	\N	1778823997412	\N	{}	2	\N	\N	\N	019e2a2c-1022-7091-8bbd-3186f9ca61e7
019e2a2c-11a2-77d9-b232-03227413ab2d	019e2a27-c102-7520-a5d9-ac2632a345a6	default	pending	api	1778823991714	1778823991732	\N	1778823997827	\N	{}	2	\N	\N	\N	019e2a2c-11a2-77d9-b232-078b3add23ba
019e2a27-e9fb-75ff-8604-662549188e42	019e2a27-ae58-739c-8835-344a06d2d580	default	completed	api	1778823719419	1778823719438	1778823719510	\N	\N	{}	1	\N	\N	\N	019e2a27-e9fb-75ff-8604-6a20f882bd59
019e2a2c-1308-710a-a349-dc3e482b7aee	019e2a27-c274-71c0-9bf3-268e44d35639	default	pending	api	1778823992072	1778823992084	\N	1778823998172	\N	{}	2	\N	\N	\N	019e2a2c-1308-710a-a349-e2ffebeec275
019e2a2c-146d-7148-a9b2-8a7cb4aef396	019e2a27-c3fa-7446-aedb-25dbcb892a9d	default	pending	api	1778823992429	1778823992443	\N	1778823998537	\N	{}	2	\N	\N	\N	019e2a2c-146d-7148-a9b2-8d6e837db21c
019e2a27-eb6c-7798-9e77-b3cd111301dc	019e2a27-afb5-76bc-ae87-988dd0d36522	default	completed	api	1778823719788	1778823719803	1778823719875	\N	\N	{}	1	\N	\N	\N	019e2a27-eb6c-7798-9e77-b58d28604493
019e2a27-ecd1-734c-baed-bf50bb7a3ebe	019e2a27-b119-773a-8bc3-d9e1a120f50e	default	completed	api	1778823720145	1778823720159	1778823720227	\N	\N	{}	1	\N	\N	\N	019e2a27-ecd1-734c-baed-c05113a4cb53
019e2a27-ee55-716e-b73e-47dff9244354	019e2a27-b27e-72dc-b59c-c332d97f8734	default	completed	api	1778823720533	1778823720550	1778823720607	\N	\N	{}	1	\N	\N	\N	019e2a27-ee55-716e-b73e-489cdb9554a8
019e2a27-efd8-77bb-8d9b-728ff860c105	019e2a27-b3ed-75dc-89e0-b9645a5bf30d	default	completed	api	1778823720920	1778823720936	1778823720998	\N	\N	{}	1	\N	\N	\N	019e2a27-efd8-77bb-8d9b-7562dd76c055
019e2a27-f135-763e-89f1-9cfbf82a21c9	019e2a27-b56e-737d-8753-a657760aafa3	default	completed	api	1778823721269	1778823721281	1778823721363	\N	\N	{}	1	\N	\N	\N	019e2a27-f135-763e-89f1-a3a33a781ce2
019e2a27-f2b4-75ff-89f8-4c68f77711fe	019e2a27-b6de-7236-ab35-c399c2e49629	default	completed	api	1778823721652	1778823721665	1778823721744	\N	\N	{}	1	\N	\N	\N	019e2a27-f2b4-75ff-89f8-501eba7413bd
019e2a27-f420-7482-a357-cc9aca9a86a0	019e2a27-b86c-763a-8a50-a98db01c2b89	default	completed	api	1778823722016	1778823722029	1778823722108	\N	\N	{}	1	\N	\N	\N	019e2a27-f420-7482-a357-d307e0be459a
019e2a28-6728-71b9-aa98-5541ae7d8827	019e2a27-b9e2-7329-a93c-659f7ab8f611	default	completed	api	1778823751464	1778823751481	1778823751566	\N	\N	{}	1	\N	\N	\N	019e2a28-6728-71b9-aa98-5a880110fecb
019e2a28-68b9-7473-b384-992b3f8dae23	019e2a27-bb47-705a-8bbc-f0feeb2f3bfb	default	completed	api	1778823751865	1778823751876	1778823751954	\N	\N	{}	1	\N	\N	\N	019e2a28-68b9-7473-b384-9ce725ac3917
019e2a28-6a24-70ed-a172-134d40f5840a	019e2a27-bcad-772b-b156-20bb6d6a0328	default	completed	api	1778823752228	1778823752239	1778823752294	\N	\N	{}	1	\N	\N	\N	019e2a28-6a24-70ed-a172-17b01950a6d8
019e2a28-6ba8-764a-8dab-cc0cd36719c5	019e2a27-be13-7188-8c61-86b20a9912d5	default	completed	api	1778823752616	1778823752632	1778823752700	\N	\N	{}	1	\N	\N	\N	019e2a28-6ba8-764a-8dab-d389e1bb96b1
019e2a28-6d38-77fa-8f1e-d39c173ef939	019e2a27-bf91-717d-82f9-b529c3088dfe	default	completed	api	1778823753016	1778823753033	1778823753118	\N	\N	{}	1	\N	\N	\N	019e2a28-6d38-77fa-8f1e-d72e5d8f5586
019e2a28-6eba-756e-8b38-cd5ab01cc825	019e2a27-c102-7520-a5d9-ac2632a345a6	default	completed	api	1778823753402	1778823753419	1778823753485	\N	\N	{}	1	\N	\N	\N	019e2a28-6eba-756e-8b38-d3ee2efaf506
019e2a28-7015-70d4-a603-728242725f76	019e2a27-c274-71c0-9bf3-268e44d35639	default	completed	api	1778823753749	1778823753765	1778823753835	\N	\N	{}	1	\N	\N	\N	019e2a28-7015-70d4-a603-740c0f7040fc
019e2a28-718b-76db-a7ae-eae07ef816c0	019e2a27-c3fa-7446-aedb-25dbcb892a9d	default	completed	api	1778823754123	1778823754136	1778823754220	\N	\N	{}	1	\N	\N	\N	019e2a28-718b-76db-a7ae-ede6dac1c055
019e2a28-730d-7229-84d8-bf4667b361ae	019e2a27-c56a-70e9-85ea-7b99dd6a1be9	default	completed	api	1778823754509	1778823754524	1778823754605	\N	\N	{}	1	\N	\N	\N	019e2a28-730d-7229-84d8-c10e6812af0a
019e2a28-7482-7564-8317-65cfabf5f758	019e2a27-c6ec-72eb-a1a3-96a31c05aeb4	default	completed	api	1778823754882	1778823754899	1778823754954	\N	\N	{}	1	\N	\N	\N	019e2a28-7482-7564-8317-6bcbb6775255
019e2a2e-e229-771b-8a5a-f6e0140daf90	019e2a27-c102-7520-a5d9-ac2632a345a6	default	pending	api	1778824176169	1778824176230	\N	1778824182388	\N	{}	2	\N	\N	\N	019e2a2e-e22a-75d9-8934-8b2f4f063032
019e2a2e-e3cc-772e-a956-dca340326f4e	019e2a27-c274-71c0-9bf3-268e44d35639	default	pending	api	1778824176588	1778824176633	\N	1778824182789	\N	{}	2	\N	\N	\N	019e2a2e-e3cc-772e-a956-e2ba924719bb
019e2a2e-e538-71ad-ac4c-cd60944b1a66	019e2a27-c3fa-7446-aedb-25dbcb892a9d	default	pending	api	1778824176952	1778824176965	\N	1778824183049	\N	{}	2	\N	\N	\N	019e2a2e-e538-71ad-ac4c-d27e3caf9d21
019e2a2f-dead-cafe-beef-deadbeef0001	019e2a27-3cdc-706c-91f4-bb8857cd5643	default	pending	test-stuck	1778817013540	1778817013540	\N	1778824320047	\N	{}	2	\N	\N	\N	019e2a2f-dead-cafe-beef-deadbeef0002
019e2ca2-3ac5-7431-9573-3840e7cc190b	019e2a27-b86c-763a-8a50-a98db01c2b89	default	completed	api	1778865289925	1778865290056	1778865290582	\N	\N	{}	1	\N	\N	\N	019e2ca2-3ac5-7431-9573-3f00dc49d731
019e2ca5-9cbf-7202-9f66-f28e316915f6	019e2a27-b86c-763a-8a50-a98db01c2b89	default	completed	api	1778865511615	1778865511689	1778865512159	\N	\N	{}	1	\N	\N	\N	019e2ca5-9cbf-7202-9f66-f5ef00648282
019e2a2f-dead-cafe-beef-deadbeef0099	019e2a13-9ddf-73e1-ac5c-66108b66008e	default	pending	dr-test	1778864694806	1778864694806	\N	1778865360110	\N	{}	2	\N	\N	\N	019e2a2f-dead-cafe-beef-deadbeef0098
\.


--
-- Data for Name: workflow_traces; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.workflow_traces (id, workspace_id, trace_id, run_id, workflow_id, status, triggered_by, started_at, completed_at, failed_at, duration_ms, step_count, error_message, created_at) FROM stdin;
019e2a1a-4508-7028-9f44-36c5b7abd544	default	019e2a18-c41a-77db-b5b7-82582a84d13d	019e2a18-c41a-77db-b5b7-7d0605b1d852	019e2a18-c402-7338-bdab-25577b1d9897	failed	rc1-test	\N	\N	1778822825478	\N	0	there is no unique or exclusion constraint matching the ON CONFLICT specification	1778822825224
019e2a1f-2e39-7788-98f5-0fc4d4fefae9	default	019e2a1f-2dd0-7016-b332-380d9917ae83	019e2a1f-2dd0-7016-b332-35d7f32f18df	019e2a18-c402-7338-bdab-25577b1d9897	completed	rc1-test-v2	\N	1778823147173	\N	78	1	\N	1778823147065
019e2a1f-da8d-71fc-9e37-f1b9b5873563	default	019e2a1f-da6a-7695-8f18-5d600625aa81	019e2a1f-da6a-7695-8f18-5986320d4ebc	019e2a18-c438-732b-88c0-38e5736ffc82	completed	rc1-fail-test	\N	1778823191301	\N	64	1	\N	1778823191181
019e2a27-e733-73eb-841f-b469a3985798	default	019e2a27-e6f5-70fd-a796-5fe06ab1981c	019e2a27-e6f5-70fd-a796-5b4e43099e1a	019e2a27-ab53-75a0-b3f8-7df80437fe20	completed	api	\N	1778823718833	\N	89	1	\N	1778823718707
019e2a27-e895-709a-9295-8b1ab81ffd3c	default	019e2a27-e87f-7203-9c33-ad596cbab721	019e2a27-e87f-7203-9c33-a97d8d196838	019e2a27-ace7-7569-bce8-75cff7a4406a	completed	api	\N	1778823719137	\N	61	1	\N	1778823719061
019e2a27-ea16-716c-80d9-a51924cb515a	default	019e2a27-e9fb-75ff-8604-6a20f882bd59	019e2a27-e9fb-75ff-8604-662549188e42	019e2a27-ae58-739c-8835-344a06d2d580	completed	api	\N	1778823719521	\N	58	1	\N	1778823719446
019e2a27-eb82-7596-acbd-088892310900	default	019e2a27-eb6c-7798-9e77-b58d28604493	019e2a27-eb6c-7798-9e77-b3cd111301dc	019e2a27-afb5-76bc-ae87-988dd0d36522	completed	api	\N	1778823719884	\N	60	1	\N	1778823719810
019e2a27-ece7-73ce-bb76-cf814cc62099	default	019e2a27-ecd1-734c-baed-c05113a4cb53	019e2a27-ecd1-734c-baed-bf50bb7a3ebe	019e2a27-b119-773a-8bc3-d9e1a120f50e	completed	api	\N	1778823720234	\N	55	1	\N	1778823720167
019e2a27-ee6c-7258-98a6-88e0a310b7a5	default	019e2a27-ee55-716e-b73e-489cdb9554a8	019e2a27-ee55-716e-b73e-47dff9244354	019e2a27-b27e-72dc-b59c-c332d97f8734	completed	api	\N	1778823720614	\N	48	1	\N	1778823720556
019e2a27-efef-7786-8537-03b8e9852f37	default	019e2a27-efd8-77bb-8d9b-7562dd76c055	019e2a27-efd8-77bb-8d9b-728ff860c105	019e2a27-b3ed-75dc-89e0-b9645a5bf30d	completed	api	\N	1778823721007	\N	50	1	\N	1778823720943
019e2a27-f146-71c6-b1ed-a2fdf4b7214e	default	019e2a27-f135-763e-89f1-a3a33a781ce2	019e2a27-f135-763e-89f1-9cfbf82a21c9	019e2a27-b56e-737d-8753-a657760aafa3	completed	api	\N	1778823721371	\N	71	1	\N	1778823721286
019e2a27-f2c7-748a-a427-996e6ab8f45a	default	019e2a27-f2b4-75ff-89f8-501eba7413bd	019e2a27-f2b4-75ff-89f8-4c68f77711fe	019e2a27-b6de-7236-ab35-c399c2e49629	completed	api	\N	1778823721752	\N	69	1	\N	1778823721671
019e2a27-f434-70cb-b9dc-39346da2b9bb	default	019e2a27-f420-7482-a357-d307e0be459a	019e2a27-f420-7482-a357-cc9aca9a86a0	019e2a27-b86c-763a-8a50-a98db01c2b89	completed	api	\N	1778823722119	\N	66	1	\N	1778823722036
019e2a28-6742-70e7-b2ab-427428b8cc29	default	019e2a28-6728-71b9-aa98-5a880110fecb	019e2a28-6728-71b9-aa98-5541ae7d8827	019e2a27-b9e2-7329-a93c-659f7ab8f611	completed	api	\N	1778823751573	\N	60	1	\N	1778823751490
019e2a28-68cb-75a8-9624-f586e0c8b2d8	default	019e2a28-68b9-7473-b384-9ce725ac3917	019e2a28-68b9-7473-b384-992b3f8dae23	019e2a27-bb47-705a-8bbc-f0feeb2f3bfb	completed	api	\N	1778823751962	\N	65	1	\N	1778823751883
019e2a28-6a34-73ac-8fb6-b0749c917af5	default	019e2a28-6a24-70ed-a172-17b01950a6d8	019e2a28-6a24-70ed-a172-134d40f5840a	019e2a27-bcad-772b-b156-20bb6d6a0328	completed	api	\N	1778823752303	\N	47	1	\N	1778823752244
019e2a28-6bbe-707c-91ce-137ec20d1f87	default	019e2a28-6ba8-764a-8dab-d389e1bb96b1	019e2a28-6ba8-764a-8dab-cc0cd36719c5	019e2a27-be13-7188-8c61-86b20a9912d5	completed	api	\N	1778823752707	\N	57	1	\N	1778823752638
019e2a28-6d4e-7159-b950-12ead58d1728	default	019e2a28-6d38-77fa-8f1e-d72e5d8f5586	019e2a28-6d38-77fa-8f1e-d39c173ef939	019e2a27-bf91-717d-82f9-b529c3088dfe	completed	api	\N	1778823753126	\N	75	1	\N	1778823753038
019e2a28-6ed3-70d3-b921-f0516c060a4b	default	019e2a28-6eba-756e-8b38-d3ee2efaf506	019e2a28-6eba-756e-8b38-cd5ab01cc825	019e2a27-c102-7520-a5d9-ac2632a345a6	completed	api	\N	1778823753494	\N	53	1	\N	1778823753427
019e2a28-7032-732e-97dc-ddc26c9ab33a	default	019e2a28-7015-70d4-a603-740c0f7040fc	019e2a28-7015-70d4-a603-728242725f76	019e2a27-c274-71c0-9bf3-268e44d35639	completed	api	\N	1778823753843	\N	53	1	\N	1778823753778
019e2a28-719d-76ba-98ad-1eb15e80625f	default	019e2a28-718b-76db-a7ae-ede6dac1c055	019e2a28-718b-76db-a7ae-eae07ef816c0	019e2a27-c3fa-7446-aedb-25dbcb892a9d	completed	api	\N	1778823754228	\N	74	1	\N	1778823754141
019e2a28-7332-7784-a84b-c01ca6419f77	default	019e2a28-730d-7229-84d8-c10e6812af0a	019e2a28-730d-7229-84d8-bf4667b361ae	019e2a27-c56a-70e9-85ea-7b99dd6a1be9	completed	api	\N	1778823754613	\N	53	1	\N	1778823754546
019e2a28-7498-75b5-be12-b8fbb2c8f959	default	019e2a28-7482-7564-8317-6bcbb6775255	019e2a28-7482-7564-8317-65cfabf5f758	019e2a27-c6ec-72eb-a1a3-96a31c05aeb4	completed	api	\N	1778823754960	\N	46	1	\N	1778823754904
019e2a2c-0a46-72c8-ab9b-c9096bc1e505	default	019e2a2c-0a14-72bc-93b7-dd7d17623973	019e2a2c-0a14-72bc-93b7-db0e9832a320	019e2a27-b9e2-7329-a93c-659f7ab8f611	failed	api	\N	\N	1778823995991	\N	0	Step s1 failed: HTTP request failed: fetch failed	1778823989830
019e2a2c-0bc8-741c-b653-fd9674807be1	default	019e2a2c-0b91-77b0-8550-ef199b37d9c9	019e2a2c-0b91-77b0-8550-e808491fb484	019e2a27-bb47-705a-8bbc-f0feeb2f3bfb	failed	api	\N	\N	1778823996387	\N	0	Step s1 failed: HTTP request failed: fetch failed	1778823990216
019e2a2c-0d33-71df-b9e5-864620f6ea88	default	019e2a2c-0d1e-7219-b020-70ec11d66e58	019e2a2c-0d1e-7219-b020-6e619b701baf	019e2a27-bcad-772b-b156-20bb6d6a0328	failed	api	\N	\N	1778823996680	\N	0	Step s1 failed: HTTP request failed: fetch failed	1778823990579
019e2a2c-0e9a-715f-9e89-ff38f08e1c3b	default	019e2a2c-0e88-725f-a375-d6a98359d140	019e2a2c-0e88-725f-a375-d0c1033b7e02	019e2a27-be13-7188-8c61-86b20a9912d5	failed	api	\N	\N	1778823997029	\N	0	Step s1 failed: HTTP request failed: fetch failed	1778823990938
019e2a2c-1034-7602-9e05-771a749514a6	default	019e2a2c-1022-7091-8bbd-3186f9ca61e7	019e2a2c-1022-7091-8bbd-2df084dd2aaa	019e2a27-bf91-717d-82f9-b529c3088dfe	failed	api	\N	\N	1778823997423	\N	0	Step s1 failed: HTTP request failed: fetch failed	1778823991348
019e2a2c-1319-767f-bbb2-a6f87ad0d3e6	default	019e2a2c-1308-710a-a349-e2ffebeec275	019e2a2c-1308-710a-a349-dc3e482b7aee	019e2a27-c274-71c0-9bf3-268e44d35639	failed	api	\N	\N	1778823998183	\N	0	Step s1 failed: HTTP request failed: fetch failed	1778823992089
019e2a2c-1605-75ec-aac1-304813aad487	default	019e2a2c-15ed-700f-ad86-94cb71e730b7	019e2a2c-15ed-700f-ad86-93cbb396bb5b	019e2a27-c56a-70e9-85ea-7b99dd6a1be9	failed	api	\N	\N	1778823998933	\N	0	Step s1 failed: HTTP request failed: fetch failed	1778823992837
019e2a2c-11bb-743b-b0bf-45d7e3260861	default	019e2a2c-11a2-77d9-b232-078b3add23ba	019e2a2c-11a2-77d9-b232-03227413ab2d	019e2a27-c102-7520-a5d9-ac2632a345a6	failed	api	\N	\N	1778823997838	\N	0	Step s1 failed: HTTP request failed: fetch failed	1778823991740
019e2a2c-1482-7421-9644-ae8775f3f524	default	019e2a2c-146d-7148-a9b2-8d6e837db21c	019e2a2c-146d-7148-a9b2-8a7cb4aef396	019e2a27-c3fa-7446-aedb-25dbcb892a9d	failed	api	\N	\N	1778823998548	\N	0	Step s1 failed: HTTP request failed: fetch failed	1778823992450
019e2a2c-177c-74e8-a01e-308e45821fe3	default	019e2a2c-1766-711c-ba86-f58d40675229	019e2a2c-1766-711c-ba86-f012b9ed7d03	019e2a27-c6ec-72eb-a1a3-96a31c05aeb4	failed	api	\N	\N	1778823999301	\N	0	Step s1 failed: HTTP request failed: fetch failed	1778823993212
019e2a2e-e273-740d-950e-19c4df84f49b	default	019e2a2e-e22a-75d9-8934-8b2f4f063032	019e2a2e-e229-771b-8a5a-f6e0140daf90	019e2a27-c102-7520-a5d9-ac2632a345a6	failed	api	\N	\N	1778824182404	\N	0	Step s1 failed: HTTP request failed: fetch failed	1778824176243
019e2a2e-e403-778d-84a1-da4d650b93a2	default	019e2a2e-e3cc-772e-a956-e2ba924719bb	019e2a2e-e3cc-772e-a956-dca340326f4e	019e2a27-c274-71c0-9bf3-268e44d35639	failed	api	\N	\N	1778824182805	\N	0	Step s1 failed: HTTP request failed: fetch failed	1778824176643
019e2a2e-e54c-716c-8923-7f6e39ffbf7c	default	019e2a2e-e538-71ad-ac4c-d27e3caf9d21	019e2a2e-e538-71ad-ac4c-cd60944b1a66	019e2a27-c3fa-7446-aedb-25dbcb892a9d	failed	api	\N	\N	1778824183062	\N	0	Step s1 failed: HTTP request failed: fetch failed	1778824176972
019e2ca2-3b62-700e-891c-e468d45e7ab4	default	019e2ca2-3ac5-7431-9573-3f00dc49d731	019e2ca2-3ac5-7431-9573-3840e7cc190b	019e2a27-b86c-763a-8a50-a98db01c2b89	completed	api	\N	1778865290596	\N	427	1	\N	1778865290082
019e2ca5-9d19-7411-880f-b0e6f95324a4	default	019e2ca5-9cbf-7202-9f66-f5ef00648282	019e2ca5-9cbf-7202-9f66-f28e316915f6	019e2a27-b86c-763a-8a50-a98db01c2b89	completed	api	\N	1778865512170	\N	404	1	\N	1778865511705
\.


--
-- Data for Name: workspaces; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.workspaces (id, name, slug, plan, owner_id, settings, created_at, updated_at) FROM stdin;
default	Acme Corp	acme-corp	pro	user_acme_owner	{"theme": "dark", "timezone": "America/New_York", "aiProvider": "anthropic"}	1776230389214	1778822389214
\.


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: ai_usage ai_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_pkey PRIMARY KEY (id);


--
-- Name: api_tokens api_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);


--
-- Name: api_tokens api_tokens_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_token_hash_unique UNIQUE (token_hash);


--
-- Name: approval_traces approval_traces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_traces
    ADD CONSTRAINT approval_traces_pkey PRIMARY KEY (id);


--
-- Name: approvals approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);


--
-- Name: briefing_items briefing_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_items
    ADD CONSTRAINT briefing_items_pkey PRIMARY KEY (id);


--
-- Name: briefings briefings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefings
    ADD CONSTRAINT briefings_pkey PRIMARY KEY (id);


--
-- Name: browser_actions browser_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_actions
    ADD CONSTRAINT browser_actions_pkey PRIMARY KEY (id);


--
-- Name: browser_sessions browser_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_pkey PRIMARY KEY (id);


--
-- Name: businesses businesses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_pkey PRIMARY KEY (id);


--
-- Name: dead_letter_jobs dead_letter_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dead_letter_jobs
    ADD CONSTRAINT dead_letter_jobs_pkey PRIMARY KEY (id);


--
-- Name: event_traces event_traces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_traces
    ADD CONSTRAINT event_traces_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: failure_lineages failure_lineages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.failure_lineages
    ADD CONSTRAINT failure_lineages_pkey PRIMARY KEY (id);


--
-- Name: insights insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights
    ADD CONSTRAINT insights_pkey PRIMARY KEY (id);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: opportunities opportunities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opportunities
    ADD CONSTRAINT opportunities_pkey PRIMARY KEY (id);


--
-- Name: policy_traces policy_traces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_traces
    ADD CONSTRAINT policy_traces_pkey PRIMARY KEY (id);


--
-- Name: queue_traces queue_traces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue_traces
    ADD CONSTRAINT queue_traces_pkey PRIMARY KEY (id);


--
-- Name: recovery_checkpoints recovery_checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_checkpoints
    ADD CONSTRAINT recovery_checkpoints_pkey PRIMARY KEY (id);


--
-- Name: recovery_log recovery_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_log
    ADD CONSTRAINT recovery_log_pkey PRIMARY KEY (id);


--
-- Name: risks risks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.risks
    ADD CONSTRAINT risks_pkey PRIMARY KEY (id);


--
-- Name: rollback_requests rollback_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rollback_requests
    ADD CONSTRAINT rollback_requests_pkey PRIMARY KEY (id);


--
-- Name: rollback_results rollback_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rollback_results
    ADD CONSTRAINT rollback_results_pkey PRIMARY KEY (id);


--
-- Name: scheduled_triggers scheduled_triggers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_triggers
    ADD CONSTRAINT scheduled_triggers_pkey PRIMARY KEY (id);


--
-- Name: snapshot_items snapshot_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot_items
    ADD CONSTRAINT snapshot_items_pkey PRIMARY KEY (id);


--
-- Name: snapshots snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshots
    ADD CONSTRAINT snapshots_pkey PRIMARY KEY (id);


--
-- Name: step_runs step_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_runs
    ADD CONSTRAINT step_runs_pkey PRIMARY KEY (id);


--
-- Name: strategic_goals strategic_goals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategic_goals
    ADD CONSTRAINT strategic_goals_pkey PRIMARY KEY (id);


--
-- Name: task_traces task_traces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_traces
    ADD CONSTRAINT task_traces_pkey PRIMARY KEY (id);


--
-- Name: webhook_deliveries webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: webhooks webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_pkey PRIMARY KEY (id);


--
-- Name: worker_traces worker_traces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_traces
    ADD CONSTRAINT worker_traces_pkey PRIMARY KEY (id);


--
-- Name: workflow_definitions workflow_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_definitions
    ADD CONSTRAINT workflow_definitions_pkey PRIMARY KEY (id);


--
-- Name: workflow_runs workflow_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_pkey PRIMARY KEY (id);


--
-- Name: workflow_traces workflow_traces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_traces
    ADD CONSTRAINT workflow_traces_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_slug_unique UNIQUE (slug);


--
-- Name: agent_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_status_idx ON public.agents USING btree (status);


--
-- Name: agent_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_workspace_idx ON public.agents USING btree (workspace_id);


--
-- Name: ai_usage_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_timestamp_idx ON public.ai_usage USING btree ("timestamp");


--
-- Name: ai_usage_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_workspace_idx ON public.ai_usage USING btree (workspace_id);


--
-- Name: approval_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_expires_idx ON public.approvals USING btree (expires_at);


--
-- Name: approval_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_status_idx ON public.approvals USING btree (status);


--
-- Name: approval_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_workspace_idx ON public.approvals USING btree (workspace_id);


--
-- Name: at_approval_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX at_approval_idx ON public.approval_traces USING btree (approval_id);


--
-- Name: at_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX at_trace_idx ON public.approval_traces USING btree (trace_id);


--
-- Name: at_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX at_workspace_idx ON public.approval_traces USING btree (workspace_id);


--
-- Name: bact_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bact_session_idx ON public.browser_actions USING btree (session_id);


--
-- Name: bact_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bact_workspace_idx ON public.browser_actions USING btree (workspace_id);


--
-- Name: bi_briefing_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bi_briefing_idx ON public.briefing_items USING btree (briefing_id);


--
-- Name: bi_converted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bi_converted_idx ON public.briefing_items USING btree (converted);


--
-- Name: bi_section_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bi_section_idx ON public.briefing_items USING btree (section);


--
-- Name: bi_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bi_workspace_idx ON public.briefing_items USING btree (workspace_id);


--
-- Name: briefing_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX briefing_created_idx ON public.briefings USING btree (created_at);


--
-- Name: briefing_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX briefing_status_idx ON public.briefings USING btree (status);


--
-- Name: briefing_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX briefing_workspace_idx ON public.briefings USING btree (workspace_id);


--
-- Name: bsess_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bsess_job_idx ON public.browser_sessions USING btree (job_id);


--
-- Name: bsess_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bsess_started_idx ON public.browser_sessions USING btree (started_at);


--
-- Name: bsess_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bsess_workspace_idx ON public.browser_sessions USING btree (workspace_id);


--
-- Name: business_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX business_workspace_idx ON public.businesses USING btree (workspace_id);


--
-- Name: dlq_dead_lettered_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dlq_dead_lettered_at_idx ON public.dead_letter_jobs USING btree (dead_lettered_at);


--
-- Name: dlq_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dlq_queue_idx ON public.dead_letter_jobs USING btree (queue_name);


--
-- Name: dlq_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dlq_workspace_idx ON public.dead_letter_jobs USING btree (workspace_id);


--
-- Name: et_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX et_created_idx ON public.event_traces USING btree (created_at);


--
-- Name: et_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX et_trace_idx ON public.event_traces USING btree (trace_id);


--
-- Name: et_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX et_workspace_idx ON public.event_traces USING btree (workspace_id);


--
-- Name: event_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_created_idx ON public.events USING btree (created_at);


--
-- Name: event_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_trace_idx ON public.events USING btree (trace_id);


--
-- Name: event_workspace_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_workspace_type_idx ON public.events USING btree (workspace_id, type);


--
-- Name: fl_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fl_run_idx ON public.failure_lineages USING btree (run_id);


--
-- Name: fl_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fl_trace_idx ON public.failure_lineages USING btree (trace_id);


--
-- Name: fl_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fl_workspace_idx ON public.failure_lineages USING btree (workspace_id);


--
-- Name: goal_horizon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX goal_horizon_idx ON public.strategic_goals USING btree (horizon);


--
-- Name: goal_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX goal_status_idx ON public.strategic_goals USING btree (status);


--
-- Name: goal_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX goal_workspace_idx ON public.strategic_goals USING btree (workspace_id);


--
-- Name: insight_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insight_category_idx ON public.insights USING btree (category);


--
-- Name: insight_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insight_created_idx ON public.insights USING btree (created_at);


--
-- Name: insight_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insight_workspace_idx ON public.insights USING btree (workspace_id);


--
-- Name: memory_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_created_idx ON public.memories USING btree (created_at);


--
-- Name: memory_tags_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_tags_idx ON public.memories USING btree (tags);


--
-- Name: memory_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_type_idx ON public.memories USING btree (type);


--
-- Name: memory_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_workspace_idx ON public.memories USING btree (workspace_id);


--
-- Name: notif_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notif_created_idx ON public.notifications USING btree (created_at);


--
-- Name: notif_read_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notif_read_idx ON public.notifications USING btree (read);


--
-- Name: notif_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notif_workspace_idx ON public.notifications USING btree (workspace_id);


--
-- Name: opportunity_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opportunity_priority_idx ON public.opportunities USING btree (priority);


--
-- Name: opportunity_score_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opportunity_score_idx ON public.opportunities USING btree (score);


--
-- Name: opportunity_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opportunity_status_idx ON public.opportunities USING btree (status);


--
-- Name: opportunity_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opportunity_type_idx ON public.opportunities USING btree (type);


--
-- Name: opportunity_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opportunity_workspace_idx ON public.opportunities USING btree (workspace_id);


--
-- Name: pt_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pt_trace_idx ON public.policy_traces USING btree (trace_id);


--
-- Name: pt_verdict_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pt_verdict_idx ON public.policy_traces USING btree (verdict);


--
-- Name: pt_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pt_workspace_idx ON public.policy_traces USING btree (workspace_id);


--
-- Name: qt_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qt_job_idx ON public.queue_traces USING btree (job_id);


--
-- Name: qt_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qt_queue_idx ON public.queue_traces USING btree (queue_name);


--
-- Name: qt_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qt_trace_idx ON public.queue_traces USING btree (trace_id);


--
-- Name: rb_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rb_request_idx ON public.rollback_results USING btree (request_id);


--
-- Name: rb_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rb_workspace_idx ON public.rollback_results USING btree (workspace_id);


--
-- Name: rcp_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rcp_run_idx ON public.recovery_checkpoints USING btree (run_id);


--
-- Name: rcp_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rcp_workspace_idx ON public.recovery_checkpoints USING btree (workspace_id);


--
-- Name: recovery_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_run_idx ON public.recovery_log USING btree (run_id);


--
-- Name: recovery_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_workspace_idx ON public.recovery_log USING btree (workspace_id);


--
-- Name: risk_score_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX risk_score_idx ON public.risks USING btree (risk_score);


--
-- Name: risk_severity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX risk_severity_idx ON public.risks USING btree (severity);


--
-- Name: risk_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX risk_workspace_idx ON public.risks USING btree (workspace_id);


--
-- Name: rr_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rr_run_idx ON public.rollback_requests USING btree (run_id);


--
-- Name: rr_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rr_status_idx ON public.rollback_requests USING btree (status);


--
-- Name: rr_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rr_workspace_idx ON public.rollback_requests USING btree (workspace_id);


--
-- Name: scheduled_triggers_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduled_triggers_enabled_idx ON public.scheduled_triggers USING btree (enabled, next_run_at);


--
-- Name: scheduled_triggers_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduled_triggers_ws_idx ON public.scheduled_triggers USING btree (workspace_id);


--
-- Name: si_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX si_entity_idx ON public.snapshot_items USING btree (entity_type, entity_id);


--
-- Name: si_snapshot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX si_snapshot_idx ON public.snapshot_items USING btree (snapshot_id);


--
-- Name: snap_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snap_run_idx ON public.snapshots USING btree (run_id);


--
-- Name: snap_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snap_trace_idx ON public.snapshots USING btree (trace_id);


--
-- Name: snap_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snap_workspace_idx ON public.snapshots USING btree (workspace_id);


--
-- Name: step_run_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_run_run_idx ON public.step_runs USING btree (run_id);


--
-- Name: step_run_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_run_status_idx ON public.step_runs USING btree (status);


--
-- Name: token_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX token_hash_idx ON public.api_tokens USING btree (token_hash);


--
-- Name: token_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX token_workspace_idx ON public.api_tokens USING btree (workspace_id);


--
-- Name: tt_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tt_run_idx ON public.task_traces USING btree (run_id);


--
-- Name: tt_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tt_trace_idx ON public.task_traces USING btree (trace_id);


--
-- Name: tt_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tt_workspace_idx ON public.task_traces USING btree (workspace_id);


--
-- Name: wdel_webhook_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wdel_webhook_idx ON public.webhook_deliveries USING btree (webhook_id);


--
-- Name: wdel_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wdel_workspace_idx ON public.webhook_deliveries USING btree (workspace_id);


--
-- Name: webhook_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX webhook_active_idx ON public.webhooks USING btree (active);


--
-- Name: webhook_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX webhook_workspace_idx ON public.webhooks USING btree (workspace_id);


--
-- Name: workflow_def_tags_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_def_tags_idx ON public.workflow_definitions USING btree (tags);


--
-- Name: workflow_def_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_def_workspace_idx ON public.workflow_definitions USING btree (workspace_id);


--
-- Name: workflow_run_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_run_status_idx ON public.workflow_runs USING btree (status);


--
-- Name: workflow_run_triggered_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_run_triggered_idx ON public.workflow_runs USING btree (triggered_at);


--
-- Name: workflow_run_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_run_workspace_idx ON public.workflow_runs USING btree (workspace_id);


--
-- Name: wort_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wort_queue_idx ON public.worker_traces USING btree (queue_name);


--
-- Name: wort_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wort_trace_idx ON public.worker_traces USING btree (trace_id);


--
-- Name: wort_worker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wort_worker_idx ON public.worker_traces USING btree (worker_id);


--
-- Name: wt_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wt_run_idx ON public.workflow_traces USING btree (run_id);


--
-- Name: wt_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wt_trace_idx ON public.workflow_traces USING btree (trace_id);


--
-- Name: wt_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wt_workspace_idx ON public.workflow_traces USING btree (workspace_id);


--
-- Name: agents agents_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: approvals approvals_run_id_workflow_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_run_id_workflow_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE;


--
-- Name: approvals approvals_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: briefing_items briefing_items_briefing_id_briefings_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_items
    ADD CONSTRAINT briefing_items_briefing_id_briefings_id_fk FOREIGN KEY (briefing_id) REFERENCES public.briefings(id) ON DELETE CASCADE;


--
-- Name: browser_actions browser_actions_session_id_browser_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_actions
    ADD CONSTRAINT browser_actions_session_id_browser_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.browser_sessions(id) ON DELETE CASCADE;


--
-- Name: browser_sessions browser_sessions_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: businesses businesses_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: events events_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: insights insights_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights
    ADD CONSTRAINT insights_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: memories memories_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: opportunities opportunities_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opportunities
    ADD CONSTRAINT opportunities_business_id_businesses_id_fk FOREIGN KEY (business_id) REFERENCES public.businesses(id);


--
-- Name: opportunities opportunities_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opportunities
    ADD CONSTRAINT opportunities_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: risks risks_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.risks
    ADD CONSTRAINT risks_business_id_businesses_id_fk FOREIGN KEY (business_id) REFERENCES public.businesses(id);


--
-- Name: risks risks_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.risks
    ADD CONSTRAINT risks_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: rollback_results rollback_results_item_id_snapshot_items_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rollback_results
    ADD CONSTRAINT rollback_results_item_id_snapshot_items_id_fk FOREIGN KEY (item_id) REFERENCES public.snapshot_items(id);


--
-- Name: rollback_results rollback_results_request_id_rollback_requests_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rollback_results
    ADD CONSTRAINT rollback_results_request_id_rollback_requests_id_fk FOREIGN KEY (request_id) REFERENCES public.rollback_requests(id) ON DELETE CASCADE;


--
-- Name: snapshot_items snapshot_items_snapshot_id_snapshots_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot_items
    ADD CONSTRAINT snapshot_items_snapshot_id_snapshots_id_fk FOREIGN KEY (snapshot_id) REFERENCES public.snapshots(id) ON DELETE CASCADE;


--
-- Name: step_runs step_runs_run_id_workflow_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_runs
    ADD CONSTRAINT step_runs_run_id_workflow_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE;


--
-- Name: strategic_goals strategic_goals_business_id_businesses_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategic_goals
    ADD CONSTRAINT strategic_goals_business_id_businesses_id_fk FOREIGN KEY (business_id) REFERENCES public.businesses(id);


--
-- Name: strategic_goals strategic_goals_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strategic_goals
    ADD CONSTRAINT strategic_goals_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_webhook_id_webhooks_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_webhook_id_webhooks_id_fk FOREIGN KEY (webhook_id) REFERENCES public.webhooks(id) ON DELETE CASCADE;


--
-- Name: workflow_definitions workflow_definitions_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_definitions
    ADD CONSTRAINT workflow_definitions_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workflow_runs workflow_runs_workflow_id_workflow_definitions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_workflow_id_workflow_definitions_id_fk FOREIGN KEY (workflow_id) REFERENCES public.workflow_definitions(id);


--
-- Name: workflow_runs workflow_runs_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict IIgsEoyQINLRjVmS7G4aieW8uD4E23sXJnkafFhAJUuOrrQtQFc4ILRfLcQPvh1

