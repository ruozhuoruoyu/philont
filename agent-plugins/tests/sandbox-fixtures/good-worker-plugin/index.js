/**
 * Good plugin running in worker sandbox.
 * Uses only declared env, exposes a simple tool and hook.
 */
export function register(ctx) {
  ctx.registerTool({
    name: 'echo',
    description: 'echoes input',
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    capability: 'read',
    domain: 'local',
    async execute(params) {
      return {
        success: true,
        output: `echo(${params.text}) env_seen=${process.env.ALLOWED_VAR ?? 'none'}`,
      };
    },
  });

  ctx.registerHook('on_session_start', (payload) => {
    return { received: payload };
  });
}
