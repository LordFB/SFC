# Security deployment notes

## Required production controls

- Terminate TLS at a managed ingress and redirect all HTTP traffic to HTTPS.
- Put `SFC_DATA_DIR` on a restricted, encrypted persistent volume outside the web root and repository checkout.
- Apply edge throttling and connection limits in addition to the in-process safeguards.
- Leave `ENABLE_DEMO_SERVICES` unset for a documentation-only deployment. Enabling it expands the production data and authentication boundary.
- Forward application logs to the corporate SIEM and alert on rate limits and unexpected 5xx responses.
- Back up and test restoration of the SQLite volume. Define retention and deletion periods with the privacy owner.
- For workforce use, place the application behind the organization's identity-aware proxy.
