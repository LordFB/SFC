# Security deployment notes

## Required production controls

- Terminate TLS at a managed ingress and redirect all HTTP traffic to HTTPS.
- Set `AUTH_ORIGIN` to the exact public HTTPS origin and `AUTH_RP_ID` to its hostname.
- Put `SFC_DATA_DIR` on a restricted, encrypted persistent volume outside the web root and repository checkout.
- Apply edge throttling and connection limits in addition to the in-process safeguards.
- Leave `ENABLE_DEMO_SERVICES` unset for a documentation-only deployment. Enabling it expands the production data and authentication boundary.
- Forward application logs to the corporate SIEM and alert on authentication failures, rate limits, and unexpected 5xx responses.
- Back up and test restoration of the SQLite volume. Define retention and deletion periods with the privacy owner.
- For workforce use, place the application behind the corporate identity-aware proxy or replace password registration with the organization's OIDC/SAML provider and MFA policy.

## Historical database cleanup

`shop.db` is ignored and removed from the current Git index, but older commits may still contain it. A repository administrator must:

1. Determine whether historical records were synthetic or personal data and follow the incident-response process if necessary.
2. Reset affected passwords and revoke sessions before distributing a cleaned repository.
3. Rewrite all branches and tags with an approved history-rewrite procedure, then invalidate old clones and artifacts.
4. Scan the rewritten history for secrets and sensitive data before reopening access.

History rewriting is intentionally not automated because it changes shared repository history and requires coordination with every clone and deployment.
