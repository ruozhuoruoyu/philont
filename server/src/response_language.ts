/**
 * Response-language resolution for the open-source i18n split.
 *
 * Context: the codebase and system prompts are being moved to English for open-source
 * readability, but user-facing replies must stay in the user's language — in particular
 * WeChat users expect Chinese. This module decouples *prompt language* (English) from
 * *response language* (per channel / per user), so flipping prompts to English never
 * strands WeChat users.
 *
 * Background (note for WeChat channel maintainers): system prompts and code are migrating to
 * English for open-source readability, but user-facing replies must stay in the user's language —
 * WeChat users in particular expect Chinese. This module decouples "prompt language (English)"
 * from "response language (per channel / per user)", ensuring WeChat users still receive
 * Chinese after the prompts are flipped to English.
 */

/** Human-readable language name fed to the model, e.g. 'Chinese', 'English'. */
export type ResponseLanguage = string;

/**
 * Per-channel default response language. The channel id is the prefix before the first
 * ':' in a sessionId (e.g. 'wechat:acct:user' -> 'wechat'). WeChat is pinned to Chinese.
 * Channels not listed fall through to the user's own language (mirror).
 */
const CHANNEL_DEFAULT_LANGUAGE: Readonly<Record<string, ResponseLanguage>> = {
  wechat: 'Chinese',
};

/** Fallback when neither an explicit user locale nor a channel default applies. */
const MIRROR_USER_LANGUAGE: ResponseLanguage = "the user's own language";

/** Extract the channel id from a sessionId (or pass a bare channel through). */
export function channelOf(sessionIdOrChannel: string | null | undefined): string {
  return (sessionIdOrChannel ?? '').split(':')[0] ?? '';
}

/** Map a BCP-47-ish locale / `user.locale` fact value to a language name the model understands. */
export function localeToLanguage(locale: string | null | undefined): ResponseLanguage | null {
  if (typeof locale !== 'string') return null;
  const l = locale.trim().toLowerCase();
  if (!l) return null;
  if (l.startsWith('zh')) return 'Chinese';
  if (l.startsWith('en')) return 'English';
  if (l.startsWith('ja')) return 'Japanese';
  if (l.startsWith('ko')) return 'Korean';
  if (l.startsWith('fr')) return 'French';
  if (l.startsWith('de')) return 'German';
  if (l.startsWith('es')) return 'Spanish';
  if (l.startsWith('ru')) return 'Russian';
  return null; // unknown -> let caller fall back
}

/**
 * Resolve the response language. Priority:
 *   1. explicit user locale (e.g. a `user.locale` fact) wins;
 *   2. per-channel default (WeChat -> Chinese);
 *   3. mirror the user's own language.
 */
export function resolveResponseLanguage(opts: {
  channel?: string | null;
  userLocale?: string | null;
}): ResponseLanguage {
  const fromLocale = localeToLanguage(opts.userLocale);
  if (fromLocale) return fromLocale;
  const ch = channelOf(opts.channel);
  if (ch && CHANNEL_DEFAULT_LANGUAGE[ch]) return CHANNEL_DEFAULT_LANGUAGE[ch];
  return MIRROR_USER_LANGUAGE;
}

/**
 * Build the system-prompt directive that controls the user-facing reply language.
 * Appended to the (English) system prompt so the model writes the "## For User" section
 * in the resolved language while internal sections may stay English.
 */
export function buildLanguageDirective(language: ResponseLanguage): string {
  return (
    `\n\n**Response language**: Write the user-facing reply (the "## For User" section) in ${language}. ` +
    `If the user clearly writes in a different language, mirror their language instead. ` +
    `Internal sections (work log, tool traces) may stay in English.`
  );
}
