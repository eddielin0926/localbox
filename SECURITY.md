# Security Policy

## Supported versions

Until Localbox reaches 1.0, security fixes target the latest published release. Reports against the current `main` branch are also welcome.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Current `main` | Best effort |
| Older releases | No |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Email the maintainer at [eddie@eddielin.dev](mailto:eddie@eddielin.dev) with:

- the affected Localbox version or commit;
- the host operating system, Node.js version, selected backend, and Docker or Podman version and mode;
- the vulnerability's impact and required conditions;
- reproducible steps or a minimal proof of concept; and
- any known mitigations.

The maintainer will acknowledge and investigate reports as capacity permits. There is currently no guaranteed response or remediation SLA. Please allow time to investigate and coordinate a fix before public disclosure.

## Security model

Localbox is intended for local development and trusted workloads. Docker and Podman containers share the host kernel and are not a security boundary for hostile multi-tenant code. Rootless Podman maps service and container root into the invoking user's namespaces but does not isolate workloads from all authority available to that account. Docker daemons and rootful Podman services have host-root authority; access to either control socket is equivalent to host control. Running untrusted images or commands is outside the supported threat model.

Reports are still welcome for vulnerabilities that unexpectedly expose the host, escape documented restrictions, disclose secrets, or let one managed sandbox interfere with another beyond the selected backend's documented isolation model.
