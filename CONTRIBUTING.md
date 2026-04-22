# Contributing to AAMP

Thanks for your interest in contributing to AAMP.

## Scope

This repository contains the protocol definition and portable tooling around AAMP:

- `aamp-sdk`
- `aamp-cli`
- `aamp-openclaw-plugin`
- `aamp-acp-bridge`

## Before You Start

Please open an issue or start a discussion before sending large changes. This helps us align on protocol direction, package boundaries, and backward-compatibility expectations.

For small fixes, documentation improvements, or test additions, feel free to send a pull request directly.

## Development Guidelines

- Prefer small, reviewable pull requests.
- Keep the protocol surface generic and vendor-neutral.
- Do not add private endpoints, credentials, or deployment details.
- Default examples and config snippets to secure settings.
- Add or update tests when changing parser, transport, or message-shape behavior.
- Keep README examples runnable and consistent with published package behavior.

## Local Checks

Before opening a pull request, run the checks relevant to the packages you changed.

```bash
cd packages/sdks/nodejs && npm install && npm run build && npm test
cd packages/aamp-cli && npm install && npm run build
cd packages/aamp-openclaw-plugin && npm install && npm run build
cd packages/aamp-acp-bridge && npm install && npm run build
```

## Security

Do not commit secrets, production credentials, internal hostnames, or private endpoints.

If you need to disable TLS certificate verification for local testing with self-signed certificates, keep that change local and document the reason in the test setup. Public examples should keep certificate verification enabled by default.

## Licensing

By contributing to this repository, you agree that your contributions will be licensed under the repository's MIT license.
