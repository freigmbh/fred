# Contributing

This file is the source of truth for contributions to this project. It
covers branch names, merge requests, and code reviews.

## Outside contributions

FREI's GitLab holds the canonical repository. The GitHub repository is a
public mirror that maintainers update with releases.

- Open issues and pull requests on GitHub. Use conventional commit syntax
  for the pull request title, as described for merge requests below.
- The GitHub repository runs no CI. Run `pnpm typecheck` and `pnpm test`
  before you push. GitLab CI checks the change once a maintainer brings
  it over.
- A maintainer lands an accepted pull request through a GitLab merge
  request. It reaches GitHub with the next published release, and the
  maintainer closes the pull request with a link to that commit.
- Report vulnerabilities through [SECURITY.md](SECURITY.md), never in a
  public issue.
- Contributions are licensed under the [MIT License](LICENSE).

## Branch names

A branch must follow this template:
`<type>/<short_description>`

- Use one of these types: `feat`, `fix`, `chore`, `docs`, or `refactor`.
- Use a lowercase description with words separated by underscores.

Examples:

```text
feat/review_transcripts
fix/lease_reconnect
chore/update_dependencies
```

## Merge requests

- Open a merge request (MR) only when the developer explicitly asks.
- MRs target `main`.
- MR titles use conventional commit syntax and plain language:
  `<type>(<scope>): <short summary>`, with type `feat`, `fix`, `perf`,
  `refactor`, `chore`, `docs`, or `test`. CI rejects other titles; after
  editing the title, rerun the pipeline.
- The squash merge turns the title into the commit on `main`, and every
  deploy releases those titles as its release notes. Write them for the
  people who read the notes.
- Mark a breaking change to the
  [public API](docs/reference.html#versioning) with `!` before the
  colon: `feat(worker)!: drop the legacy label`. `feat` bumps the minor
  version, `!` bumps the minor version before 1.0.0 and the major
  version after, everything else bumps the patch version.
- In the description, state the problem in a sentence or two, then
  explain how you fixed it. End by naming the model and harness that did
  the work.
- Include before and after images for UI changes. Include a short video
  for changes involving motion or timing.
- One concern per MR. If the description says "also", split it.
- When babysitting an MR, poll checks and comments newer than the last
  push. Verify each bot finding against the source code. Fix valid
  findings and dismiss false positives with a written reason. Stay quiet
  when nothing is new. Stop when the bots are green on the latest
  commit.
- Enable "Delete source branch" & "Squash commits" for Merge Requests

Examples:

```text
feat(ui): filter finished reviews by model
feat(controller)!: rename the review labels
fix(worker): restore lease after reconnect
refactor(controller): simplify queue subscription
chore(deps): update dependencies
```

## AI code review

- FRED reviews merge requests through the project's **0 FRED** bot.
  Add it as reviewer to request a review. New pushes trigger another
  review while it remains assigned. On GitLab versions that emit a
  re-request webhook, use the re-request action to review the same
  commit again. After a failure, remove and re-add **0 FRED**.
- FRED sets `fred-review::findings` or `fred-review::clean`. A clean
  review has no unresolved blocking or should-fix findings from FRED.
  It can still contain nits.
- Read the summary and inline discussions, address valid findings, and
  push your fixes. FRED supports human review; it never approves an MR.
- Reviews enter a queue, so results may take time.
