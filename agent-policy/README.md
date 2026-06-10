# @agent/policy

Policy layer: permission checks + audit log

## 3×3 permission matrix

```
         local   network   system
read       ✓        ✓        ✗
write      ✓        ✗        ✗
execute    ✗        ✗        ✗
```

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
