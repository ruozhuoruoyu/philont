/**
 * time tool - get the current time (supports IANA timezones)
 */

import type { Tool } from '@agent/policy';

/** Format a date as "YYYY-MM-DD HH:mm:ss" in the specified timezone */
function formatInTimezone(date: Date, timezone: string): string {
  try {
    // sv-SE locale ordering is YYYY-MM-DD; normalize the separator between date and time
    return date.toLocaleString('sv-SE', { timeZone: timezone }).replace(' ', 'T');
  } catch {
    // Invalid timezone — fall back to UTC
    return date.toISOString().replace(/\.\d+Z$/, '');
  }
}

export const timeTool: Tool = {
  name: 'time',
  description:
    'Get the current time. Optional format (iso|unix|local) and timezone (IANA e.g. Asia/Shanghai). ' +
    'Defaults to the AGENT_TIMEZONE environment variable or UTC.',
  schema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        description: 'iso (UTC ISO8601) | unix (seconds) | local (localized per timezone)',
        enum: ['iso', 'unix', 'local'],
      },
      timezone: {
        type: 'string',
        description: 'IANA timezone string, e.g. Asia/Shanghai / America/New_York / UTC',
      },
    },
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const format = (params.format as string) || 'local';
    const tz =
      (params.timezone as string) || process.env.AGENT_TIMEZONE || 'UTC';
    const now = new Date();

    let output: string;
    if (format === 'unix') {
      output = String(Math.floor(now.getTime() / 1000));
    } else if (format === 'iso') {
      output = now.toISOString();
    } else {
      // local: display per timezone, with the IANA label appended for easy downstream reformatting by the LLM
      output = `${formatInTimezone(now, tz)} (${tz})`;
    }

    return {
      success: true,
      output,
    };
  },
};
