-- R146.176 — Video tactics analyzer: watch any video, extract editing +
-- engagement + retention + platform-ranking tactics so Novan can replicate
-- what works.

CREATE TABLE IF NOT EXISTS video_tactic_analysis (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  source_url      text NOT NULL,
  platform        text,                            -- youtube | tiktok | instagram | x | other
  duration_sec    real,
  is_short_form   boolean NOT NULL DEFAULT false,
  hook            jsonb NOT NULL DEFAULT '{}',     -- { firstWords, visualStyle, secondsToHook }
  cuts            jsonb NOT NULL DEFAULT '{}',     -- { totalCuts, cutsPerSec, avgShotSec, fastest5Sec }
  retention       jsonb NOT NULL DEFAULT '[]',     -- [{ atSec, kind: 'pattern_break'|'question'|'callback'|'reveal', desc }]
  engagement      jsonb NOT NULL DEFAULT '{}',     -- { ctas[], questionsAsked[], pollsOrPinned, commentBait }
  captions        jsonb NOT NULL DEFAULT '{}',     -- { hasAutoCaptions, style, hookEmphasis, font, color, position }
  audio           jsonb NOT NULL DEFAULT '{}',     -- { hasMusic, hasVoiceover, hasSfx, dynamicsScore }
  platform_signals jsonb NOT NULL DEFAULT '{}',    -- { useTrendingSound, hashtags[], duetReady, vertical, captionFirst3sec, etc }
  transcript      text,
  summary         text,
  score           real NOT NULL DEFAULT 0,         -- 0..1 estimated quality of execution
  cost_usd        real NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'pending', -- pending | analyzing | ready | failed
  error           text,
  created_at      bigint NOT NULL,
  analyzed_at     bigint
);
CREATE INDEX IF NOT EXISTS vta_ws_idx ON video_tactic_analysis(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vta_ws_platform_idx ON video_tactic_analysis(workspace_id, platform);

CREATE TABLE IF NOT EXISTS platform_ranking_playbook (
  id            text PRIMARY KEY,
  workspace_id  text,                              -- nullable = global preset
  platform      text NOT NULL,
  form          text NOT NULL,                     -- 'short' | 'long'
  rules         jsonb NOT NULL DEFAULT '[]',       -- [{ rule, evidence, weight }]
  version       integer NOT NULL DEFAULT 1,
  source_url    text,
  updated_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS prp_idx ON platform_ranking_playbook(coalesce(workspace_id, 'GLOBAL'), platform, form);
