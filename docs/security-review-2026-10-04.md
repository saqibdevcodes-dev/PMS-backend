# Security finding: executable loaders in ESLint configuration

During customer portal validation, both backend and frontend `eslint.config.js` files were found to contain appended obfuscated code unrelated to linting. Static decoding showed a remote-code loader that obtains JavaScript, decodes and evaluates it, and can spawn a detached hidden Node process. Both appended loaders and their supporting `createRequire` imports have been removed; the legitimate ESLint rules remain.

The backend loader was already present in repository history at commit `111fa15` (`Bug fixes`). This finding is not evidence of who introduced it. The frontend loader was also present before the cleanup. Earlier lint commands in this session loaded the affected configurations inside the restricted execution environment before the issue was identified. Whether those runs, earlier workstation runs or CI runs successfully downloaded or executed a payload has not been established.

## Preserved evidence

Original configurations are preserved as text rather than executable configuration files, together with the statically decoded loader and metadata. These paths are ignored by Git and are local investigation artifacts; retain them securely if the workspace is cleaned.

| Repository | Evidence directory              | Original configuration SHA-256                                     |
| ---------- | ------------------------------- | ------------------------------------------------------------------ |
| Backend    | `.runtime/security-review/`     | `cfc65841606143e85003c8f6e4d130d82874d529606d5c398f0c5fb79489a503` |
| Frontend   | `test-results/security-review/` | `b0712f230bbadfe6ad9e8ce9a89b4eb19d45ca41fd97c760bda055c1cb572cb6` |

Each directory contains `eslint-config-original.txt`, `decoded-loader.txt` and `evidence.json`. Do not import or execute the preserved code. Static decoding used string parsing and base64 conversion rather than executing the decoded loader.

## Scope and follow-up

The cleanup addresses the two identified configuration files. A source scan for the loader markers and direct `eval`/`atob` patterns found only the legitimate Redis Lua invocation remaining in backend application source. This scan excluded dependencies, generated build/native outputs and evidence directories; it is not a workstation, dependency, CI or production compromise assessment.

Before deployment, review the repository history and affected workstation/CI hosts from a trusted environment. Investigate executions of these configurations and any unexpected child processes or network activity. Credentials accessible to an affected process should be treated as potentially exposed; rotate them from a trusted machine as warranted, including deployment/provider credentials. Use a clean build environment after review. No secrets were rotated and no system-wide remediation was attempted as part of the portal implementation.

Passing application tests after removing the loaders does not establish that an earlier execution was harmless.
