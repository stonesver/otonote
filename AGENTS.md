# Repository guidance

For structural codebase exploration, use the installed `codebase-memory` skill.

Before changing documentation, read [the documentation policy](docs/governance/documentation.md)
and use [the document index](docs/README.md) to find the authoritative page.

- Update current explanations and runbooks with the code they describe. Ordinary
  changes do not need a new design, completion report, handoff, or release note.
- Keep unfinished work in `docs/BACKLOG.md`; remove resolved entries. Git and PRs
  retain change history. Do not create a parallel history archive.
- Public prose describes this project's requirements and behavior. Do not include
  competitor-site research, names, URLs, screenshots, or comparisons. Preserve
  required third-party attribution, licenses, and technical protocol sources.
- Keep real environment details, credentials, raw logs and private evidence outside
  the repository. Do not copy them into issues, PR descriptions or build artifacts.
- Documentation cleanup does not authorize deleting configuration, examples,
  deployment scripts, service definitions, runtime data or test fixtures. Check
  references and purpose before removing an attachment; keep uncertain files.
- Run `python3 -m tools.docs_status` and the relevant documentation tests before
  completing a documentation change. Report unverified behavior separately.
