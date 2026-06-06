/**
 * Example plugin — registers a "greet" tool
 */
export function register(ctx) {
  ctx.registerTool({
    name: 'greet',
    description: 'Return a greeting',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
    },
    capability: 'read',
    domain: 'local',
    async execute(params) {
      return {
        success: true,
        output: `Hello, ${params.name}! (from plugin ${ctx.pluginId})`,
      };
    },
  });

  ctx.registerHook('on_session_start', (payload) => {
    ctx.config && (ctx.config.__startCount = (ctx.config.__startCount || 0) + 1);
  });
}
