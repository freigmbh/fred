# Security policy

FRED handles GitLab project access tokens, an OpenRouter API key, and the
source code of the merge requests it reviews. Please report security
problems privately.

## Report a vulnerability

Use **Report a vulnerability** on the GitHub repository's **Security**
tab. GitHub keeps the report private between you and the maintainers.
Do not open a public issue, pull request, or discussion for it.

Include what you found, how to reproduce it, and the version from
`pnpm fred --version` or the end of a FRED summary comment.

## Supported versions

FRED is released continuously before 1.0.0. Fixes land in the newest
release only. Upgrade to it before you report.

## Scope

In scope: the controller, worker, admin UI, Docker stack, and the review
agent's sandbox, meaning anything that lets a merge request, a webhook, or
a reviewed repository read credentials, write outside the checkout, run
commands, or reach the network beyond OpenRouter and GitLab.

Out of scope: findings that need an already compromised host, admin
secret, or Convex admin key, and model output quality.
