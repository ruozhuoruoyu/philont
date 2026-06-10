# @agent/policy

Policy layer: permission checks + audit log

## 3×4 permission matrix

Capability (read / write / execute) × domain (local / network / system / **self**). The `self`
domain is the agent's own state (memory, skills, calendar) — mutations there don't spill outside
the agent. `createDefaultMatrix()`:

```
         local   network   system   self
read       ✓        ✓         ✗       ✓
write      ✓        ✗         ✗       ✓
execute    ✗        ✗         ✗       ✗
```

The server runs the stricter `createReadOnlyMatrix()` (same, but **external writes are denied** —
`write` is allowed only on `self`); `execute` and `system` always require explicit approval.

## Usage

```typescript
import { withPolicy, createDefaultMatrix, AuditLog } from '@agent/policy';

const audit = new AuditLog();
const delegate = withPolicy(yourDelegate, {
  permissions: createDefaultMatrix(),
  audit,
  maxStepsPerMinute: 60
});
```

## Built-in tools

- `readFile` - read + local
- `writeFile` - write + local
- `http` - read + network
- `shell` - execute + local (denied by default)

## Run the demo

```bash
cd demo
npm run demo:policy
```
