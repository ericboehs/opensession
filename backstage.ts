/**
 * Deprecated entry shim — Backstage was renamed OpenSession
 * (docs/rename-opensession-plan.md). The real entry is ./opensession.ts; this
 * file exists so the not-yet-swapped systemd unit (`backstage.service`,
 * ExecStart backstage.ts), scripts and muscle memory keep working. Boot-once
 * guards live in opensession.ts (`globalThis.__backstageBooted`), so loading
 * through either entry is identical.
 */
import "./opensession.ts";
