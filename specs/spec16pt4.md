# Axiom 0.16pt4 Specification
## CLI JSON Error Contract Corrective

**Target:** `0.16.0-alpha.4`  
**Baseline:** `0.16.0-alpha.3`  
**Scope:** CLI-only corrective  
**External validation:** targeted CLI rerun only  
**Server IR:** `axiom.server.v9` unchanged  
**Authorization runtime:** `axiom.authz.v3` unchanged  
**Tooling conformance:** `axiom.conformance.v10` unchanged

---

## 1. Purpose

Alpha.3 achieved:

```text
D1 / E1 / S1
```

with zero release-blocking findings.

One non-blocking CLI defect remains:

```text
F-CLI-JSON-NOT-HONORED-ON-ERROR
```

When `--json` is supplied, some CLI error paths still emit plain text.

Alpha.4 fixes only this issue.

---

## 2. Required invariant

When a CLI command is invoked with:

```text
--json
```

all CLI-owned output paths must emit valid JSON, including failures.

Conceptually:

```text
--json => stdout is parseable JSON
```

for both:

```text
success
failure
```

---

## 3. Required error cases

At minimum verify:

```text
explain unknown node id
analyze unknown --export
diff missing --against
missing model file
invalid graph
invalid/missing command arguments
```

For each with `--json`:

```text
parseable JSON
nonzero exit code
no plain prose on stdout
no native stack trace
```

---

## 4. Error shape

Use one stable structured error form.

Example shape:

```json
{
  "ok": false,
  "error": {
    "code": "UNKNOWN_NODE",
    "message": "No action node \"foo\" in this graph"
  }
}
```

Exact field names are implementation-defined, but the format must be:

```text
structured
deterministic
machine-readable
documented
```

---

## 5. Success behavior

Existing successful `--json` output must remain unchanged.

In particular preserve CLI ↔ AgentAPI parity for:

```text
explain
analyze
diff
validate
```

No semantic tooling changes.

---

## 6. Human mode

Without `--json`, existing human-readable CLI errors may remain unchanged.

---

## 7. Safety

JSON error handling must not expose:

```text
credentials
tokens
secrets
internal stack traces
```

unless explicitly part of an existing public diagnostic contract.

---

## 8. Non-goals

Alpha.4 must not modify:

```text
AgentAPI semantics
validateGraph semantics
semanticDiff semantics
authorization semantics
workflow semantics
distributed semantics
semanticFingerprint
authority compatibility
Server IR
```

---

## 9. Tests

Add focused regression coverage for all required error paths.

Required:

```text
success-path CLI tests green
error-path --json tests green
CLI-AgentAPI parity unchanged
all existing fast tests green
```

---

## 10. External validation

Do not rerun the full 0.16 campaign.

Run only the existing CLI section plus alpha.4-specific error-path tests.

Required result:

```text
F-CLI-JSON-NOT-HONORED-ON-ERROR CLOSED
no new CLI blockers
```

---

## 11. Freeze status

The 0.16 semantic tooling contract is already validated at:

```text
D1 / E1 / S1
```

Alpha.4 does not reopen that semantic freeze.

After targeted CLI validation passes:

```text
0.16.0-alpha.4
ready for stable 0.16.0 packaging/release
```