# Fixtures

Offline tests use these files and local synthetic transports. They contact neither GitLab nor a model provider.

- `gitlab/synthetic-nontext-split-renames.json` contains synthetic empty and binary rename halves, including mode changes.
- `gitlab/synthetic-split-rename.json` pairs an omitted lockfile patch with a complete rename represented as a deletion and addition in the raw diff. It is synthetic.
- `gitlab/synthetic-hunkless-sections.json` contains synthetic raw sections without text hunks: accepted unchanged renames, empty file changes, mode-only changes, and binary changes, plus malformed and unsupported counterparts.
- `gitlab/synthetic-omitted-split-rename.json` pairs an omitted rename patch with raw deletion and addition halves, including CRLF lines, a missing final newline, and an empty deletion half. It is synthetic.
- `webhooks/` contains hand-written GitLab 19 trigger bodies for project 7, whose `0 FRED` bot is user 901. User 902, a retired Codex reviewer in `push-while-assigned.json`, never triggers. `reviewer-added-gitlab-18.0.json` is a scrubbed real delivery from GitLab 18.0.1, with synthetic project identifiers, with the older `{ previous, current }` reviewer shape.
There are no recorded model runs or fixture MR repositories in this directory. Worker tests construct local checkout files, synthetic OpenRouter responses, fake GitLab transports, and subprocess fixtures in temporary directories.

Recording a real review against a GitLab fixture project is a human step with real keys and budget, gated by `AI_REVIEW_LIVE=1`. Use a local self-hosted controller and an explicitly selected fixture GitLab project, following [the local run guide](../docs/run-locally.html). Keep every stage response and its usage result. Include the SDK version, requested model, and resolved response model in the recording's description. The authorized `pnpm fred dev verify --live openrouter` check captures GitLab effects locally and does not require a real fixture project.

Strip credentials, private hostnames, emails, and sensitive source before committing a recording. A fixture is immutable once a test depends on it; add a new one for a new case. Label synthetic responses as synthetic.
