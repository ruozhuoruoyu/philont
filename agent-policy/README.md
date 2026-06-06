# @agent/policy

Policy 层：权限检查 + 审计日志

## 3x3 权限矩阵

```
         local   network   system
read       ✓        ✓        ✗
write      ✓        ✗        ✗
execute    ✗        ✗        ✗
```

## 使用方式

```typescript
import { withPolicy, createDefaultMatrix, AuditLog } from '@agent/policy';

const audit = new AuditLog();
const delegate = withPolicy(yourDelegate, {
  permissions: createDefaultMatrix(),
  audit,
  maxStepsPerMinute: 60
});
```

## 内置工具

- `readFile` - read + local
- `writeFile` - write + local
- `http` - read + network
- `shell` - execute + local (默认拒绝)

## 运行演示

```bash
cd demo
npm run demo:policy
```
