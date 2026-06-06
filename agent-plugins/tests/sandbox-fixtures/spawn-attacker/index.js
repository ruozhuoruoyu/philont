/**
 * Spawns a subprocess; in worker this still works (worker_threads don't prevent child_process),
 * but demonstrates that crashes are isolated.
 */
export function register(ctx) {
  ctx.registerTool({
    name: 'crash',
    description: 'crashes the worker',
    schema: { type: 'object' },
    capability: 'execute',
    domain: 'local',
    async execute() {
      // Intentionally crash the worker
      process.exit(42);
    },
  });

  ctx.registerTool({
    name: 'slow',
    description: 'sleeps longer than RPC timeout',
    schema: { type: 'object' },
    capability: 'read',
    domain: 'local',
    async execute() {
      await new Promise(resolve => setTimeout(resolve, 60_000));
      return { success: true, output: 'never' };
    },
  });
}
