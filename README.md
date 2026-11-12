# FRED

FRED stands for **Frei Review and Evaluation Daemon**. Its self-hosted Convex controller queues GitLab reviews. An Effect v4 worker runs detection and validation through the official OpenRouter SDK, with controlled repository tools.

FRED supports GitLab only, by decision. It builds on GitLab's own model: project access tokens as bot identity, reviewer assignment as the trigger, and discussions anchored to the merge request diff. There is no forge abstraction, and support for GitHub or other forges is out of scope.

Each GitLab project reviews through its own FRED bot, the bot user of a project access token named `0 FRED`. The admin connects that token on the admin UI's Projects page and chooses the project's review pipeline, any compatible OpenRouter model and effort for each stage, without a worker restart. The controller stores tokens sealed. One `OPENROUTER_API_TOKEN` supplies model access.

Project review rules live in root `REVIEW.md` and can reference skills elsewhere in the reviewed repo. The worker records observed usage, saves validated results before publication, and resumes interrupted publication without rerunning analysis.

Configure the stack with `pnpm install`, then `pnpm run setup`. The wizard explains each setting, preserves existing values, and previews local files and controller updates before saving. See [the setup instructions](docs/run-locally.html#setup-wizard).

- [Run FRED with Docker](docs/run-locally.html#docker-deployment)
- [Architecture and decisions](docs/architecture.html)
- [Runtime and contract reference](docs/reference.html)
- [Run the stack locally](docs/run-locally.html)
- [Set up GitLab](docs/setup-gitlab.html)
- FREI maintainers: FREI's own deployment is in `docs/pilot/`, which the public mirror leaves out.

Run offline checks with `pnpm test` and `pnpm -r typecheck`. Run the isolated local integration check with `pnpm fred dev verify`, or exercise OpenRouter with `pnpm fred dev verify --live openrouter`. Local checks capture GitLab effects and identify which integrations are simulated. Real GitLab acceptance and shared deployment require separate authorization.

## Contributing, security, license

- Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md). The GitHub repository is a public mirror of FREI's GitLab; maintainers land accepted pull requests there.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a public issue.
- FRED is released under the [MIT License](LICENSE). Copyright FREI GmbH.
