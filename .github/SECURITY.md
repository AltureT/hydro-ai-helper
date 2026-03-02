# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

### How to Report

1. **Email**: Send details to [myalture@gmail.com](mailto:myalture@gmail.com)
2. **GitHub Private Advisory**: Use [GitHub Security Advisories](https://github.com/AltureT/hydro-ai-helper/security/advisories/new) to report privately

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 1 week
- **Fix Release**: Depending on severity, typically within 2 weeks

### Scope

The following are in scope:

- API key encryption/decryption (`src/lib/crypto.ts`)
- Jailbreak detection bypass
- Output safety filter bypass
- Authentication/authorization issues in handlers
- MongoDB injection
- XSS in frontend components

### Out of Scope

- Vulnerabilities in HydroOJ core (report to [hydro-dev/Hydro](https://github.com/hydro-dev/Hydro))
- Vulnerabilities in third-party dependencies (report upstream)
- Denial of service via rate limiting (by design)

## Security Best Practices for Deployers

1. **Always set `ENCRYPTION_KEY`** environment variable (32 characters) — do NOT use the development default
2. Keep your HydroOJ and this plugin updated to the latest version
3. Use HTTPS for all API endpoint configurations
4. Regularly review jailbreak logs in the admin panel
