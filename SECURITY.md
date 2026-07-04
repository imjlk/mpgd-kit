# Security Policy

`mpgd-kit` includes purchase, ad reward, leaderboard, and backend ledger
examples. Treat those flows as security-sensitive.

## Supported Versions

The project is currently pre-1.0. Security fixes are applied to the main branch.

## Reporting a Vulnerability

Please do not report vulnerabilities through public issues. Use GitHub private
vulnerability reporting if it is enabled for the repository, or contact the
maintainer through their GitHub profile with a concise description and
reproduction steps.

Useful reports include:

- affected package or target
- impact and exploitability
- reproduction steps
- any relevant logs or target configuration

## Security Expectations

- Purchases and ad rewards must be granted by backend verifier or ledger APIs.
- Client callbacks are evidence, not the source of truth.
- Do not commit store credentials, signing keys, `.env` files, provisioning
  profiles, keystores, API keys, or production platform identifiers.
- Use the target smoke commands before shipping target artifacts.
