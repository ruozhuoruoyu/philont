# scripts

Helper scripts for building and running Philont.

| Script | Purpose |
| --- | --- |
| `build-all.sh` / `build-all.ps1` | Build every package in dependency order (`agent-policy → agent-tools → agent-mcp → agent-plugins → agent-memory → server / web-ui / launcher`). |
| `start.sh` / `start.ps1` | Build everything, then start the launcher (which serves the Web UI, runs the setup wizard, and supervises the agent). |

The server also ships a one-off data seeder for the memory dashboard:

```bash
(cd server && MEMORY_DB_PATH=./memory.sqlite npx tsx scripts/seed-memory.ts)
```

See [../DEPLOYMENT.md](../DEPLOYMENT.md) for the full deployment guide.
