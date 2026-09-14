# Security Policy

## Supported Versions

The project is pre-1.0. Only the latest published release on npm
(`argus-reviewer-e2e`) receives security fixes.

## Reporting a Vulnerability

Please do not open a public issue for security reports.

Report vulnerabilities via [GitHub private vulnerability reporting](https://github.com/duketopceo/Argus/security/advisories/new).
You should receive an acknowledgement within a few days.

## Notes for users

- argus-reviewer sends page screenshots to the vision model provider you
  configure (e.g. OpenRouter). Do not run it against pages containing secrets
  or personal data you are not willing to share with that provider.
- Values in `secrets` are interpolated into test steps and sent to the target
  app — keep them out of committed config and out of test files.
- `delegate` and `heal: 'a0'` hand control to your own Agent Zero instance;
  review that instance's trust settings separately.
