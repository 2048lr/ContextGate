# Security Policy

## Supported versions

Only the latest minor release line receives security fixes. The project runs on
Windows; Linux/macOS development is paused and those builds are **not** supported.

| Version | Supported |
|---------|-----------|
| 5.5.x and later | ✅ |
| 5.4.x and earlier | ❌ |

The runtime is upgraded in lockstep with Chromium security releases. Releases built
on an [end-of-life Electron major](https://endoflife.date/electron) are not supported —
check the version shown in **设置 → 安全** (Settings → Security) before reporting.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

1. **Preferred — GitHub private vulnerability reporting:** open
   <https://github.com/2048lr/ContextGate/security/advisories/new>. This keeps the
   report private until a fix is published.
2. **Email:** <liurun637@gmail.com> with the subject prefix `[SECURITY]`.

Include, as far as you can:

- the affected version (`package.json` version, or the version shown in the app);
- your OS and whether you run the GUI or `cli.js`;
- a description of the impact (what an attacker gains);
- reproduction steps or a proof of concept;
- any suggested fix.

### What to expect

| Stage | Target |
|-------|--------|
| Acknowledgement | 3 business days |
| Initial assessment (severity + affected versions) | 10 business days |
| Fix or mitigation | depends on severity; Critical issues are prioritised over feature work |
| Public disclosure | coordinated with you, after a fixed release is available |

This is a single-maintainer project, so these are best-effort targets rather than
contractual commitments. Credit is given in the advisory unless you ask to stay
anonymous.

## Threat model — what this project does and does not defend against

ContextGate runs a local proxy on loopback and stores provider API keys on disk.
The relevant adversary is **another program running as the same user** and
**a web page the user visits** (DNS rebinding / cross-site requests to loopback).
It is *not* designed to defend against an attacker who already has code execution
as your user, nor against a compromised upstream provider.

### Mitigations that are on by default

- **Local token auth.** Except for `/health`, every proxy endpoint requires a token
  generated on first launch (`proxy.local_token`). Anonymous requests get `401`.
- **Host header allowlist.** Requests whose `Host` header is not loopback get `403`,
  which blocks DNS rebinding.
- **Origin rejection.** Requests carrying a cross-site `Origin` header get `403`.
- **Loopback bind.** `proxy.host` defaults to `127.0.0.1`. Binding elsewhere produces a
  startup warning (and remote clients are still rejected by the Host check).
- **Renderer sandbox.** Chromium's sandbox is enabled for every process
  (`app.enableSandbox()` plus `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`). The renderer has no Node `require`.
- **Navigation guard.** In-window navigation is restricted to the app's own files;
  `window.open` and `<webview>` are denied; only hosts in
  `security.allowed_external_hosts` (default `github.com`, https only) may be handed to
  the system browser. All permission requests (camera, microphone, notifications,
  geolocation…) are denied.
- **No TLS downgrade.** A provider asking for `tls.reject_unauthorized: false` is
  ignored unless `security.allow_insecure_tls` is explicitly enabled.

### Known limitations (be aware before relying on this for sensitive work)

- **API keys are stored in plaintext** in `%APPDATA%\ContextGate\config.yaml`. Any
  process running as your user can read them. Moving to Electron `safeStorage`
  (Windows DPAPI) is tracked as FIX-13 and not yet implemented.
- **Disabling auth is possible.** `proxy.auth.enabled: false` restores anonymous
  access. The app warns loudly when it is off.
- **`X-Target-Base-Url` SSRF surface.** An authenticated caller can ask the proxy to
  fetch a model list from a URL they choose. It is limited to http/https and requires
  the local token; set `proxy.auth.allow_target_base_url: false` to remove it.
- **Keys are sent to the provider you configure**, obviously; nothing is sent anywhere
  else. See the data-flow section in [README.md](README.md).
- **No telemetry.** The application does not start Electron's `crashReporter` and sends
  no analytics. The only unconditioned outbound request is the models.dev price
  catalog (24h disk cache in the user data directory).

## Verifying the hardening yourself

```bash
# 1) No sandbox-disabling switches anywhere in the entry point
Select-String -Path app/gui-js/main.js -Pattern 'no-sandbox|disable-setuid-sandbox|disable-gpu-sandbox'
# expect: no matches

# 2) Sandbox state at runtime (needs a desktop session)
npm --prefix app/gui-js run verify:sandbox
# expect: renderer.sandboxed === true, renderer.contextIsolated === true, hasNodeRequire === false

# 3) Anonymous access is rejected
curl -i http://127.0.0.1:12306/stats          # expect 401
curl -i -H "Host: evil.com" http://127.0.0.1:12306/stats   # expect 403
```
