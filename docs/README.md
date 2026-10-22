# Aelix Studio Docs

Documentation is organized by reader intent, not by document type.

| Directory                       | For whom                 | What lives here                                                                                                               |
| ------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| [`guides/`](guides)             | Users & operators        | How to deploy, test, and run the product. Server deployment, WebUI, Hub testing, CDP debugging.                               |
| [`contributing/`](contributing) | Contributors             | Dev environment setup, file-structure conventions, PR automation workflow.                                                    |
| [`architecture/`](architecture) | Engineers & architects   | System architecture overview, subsystem deep-dives (ACP, queue, team mode), and supporting research notes.                    |
| [`specs/`](specs)               | Engineering-driven specs | Feature design docs, requirements, implementation plans (ACP rewrite, extension market, remote agent, wake prompt, PR notes). |
| [`prds/`](prds)                 | Product team             | Formal Product Requirement Documents maintained by the product team. **Do not reorganize without their consent.**             |
| [`readme/`](readme)             | Global users             | Translated copies of the root `readme.md` (Chinese, Japanese, Korean, Spanish, etc.).                                         |

## Quick pointers

- Studio distribution: [`aelix-studio/README.md`](aelix-studio/README.md).
- Windows: [`aelix-studio/windows.md`](aelix-studio/windows.md).
- Self-hosting and network review: [`aelix-studio/self-hosting.md`](aelix-studio/self-hosting.md).

- New to the project? Start with [`architecture/overview.md`](architecture/overview.md).
- Setting up a dev environment? See [`contributing/development.md`](contributing/development.md).
- Writing code? The entry point for code-style, linting, formatting, and commit rules is [`AGENTS.md`](../AGENTS.md) at the repo root.
- The other guides and PRDs retain upstream context; Studio deployment instructions above take precedence.

## Where to put new docs

| Content type                                               | Destination                 |
| ---------------------------------------------------------- | --------------------------- |
| User/ops-facing how-to                                     | `guides/`                   |
| Contributor convention, workflow, or tooling rule          | `contributing/`             |
| System or subsystem design, technical analysis             | `architecture/`             |
| Exploratory research, analysis reports                     | `architecture/research/`    |
| Feature requirements / design drafts driven by engineering | `specs/<feature-name>/`     |
| Formal PRD owned by product team                           | `prds/` (coordinate first)  |
| README translation                                         | `readme/readme_<locale>.md` |
