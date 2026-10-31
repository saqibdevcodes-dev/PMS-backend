# Archive and lint dependency overrides

The moderate audit gate requires minimatch 11.0.1 or later for
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
The matcher is pinned to 11.0.2. ESLint and readdir-glob use its public matching API.

The ExcelJS archive dependency chain also needs compatible overrides:

- Glob 14.0.3 uses minimatch 11 and preserves the synchronous expansion API used by archiver-utils. Glob 7 depends on matcher internals that changed in version 11.
- Fstream receives rimraf 2.2.8, the callback-based version without a glob dependency. Fstream only uses it to remove literal paths before writing. Later rimraf 2.x versions depend on Glob 7's removed callback API and cannot be combined with Glob 14.

`tests/dependency-compatibility.test.ts` checks recursive archive expansion,
exclusion patterns, and the writer's literal-path replacement/cleanup.
The export-layout and integration suites also exercise complete Excel output.

Review these overrides together when upgrading ExcelJS or replacing its legacy
archive dependencies. Do not override minimatch alone or use a forced audit fix
that downgrades the main lint/export libraries.
