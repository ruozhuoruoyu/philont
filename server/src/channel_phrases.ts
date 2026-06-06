/**
 * Channel interaction semantic phrases (2026-05-19 three-stream architecture)
 *
 * Translates tool names into user-friendly semantic progress phrases — used by
 * the Tier-2 progress stream (onStatus).
 *
 * Design principles:
 *   - Never expose tool names to users (shell / webSearch are internal names meaningless to users)
 *   - Send "working on X…" before a call; "⚠ X failed…" on failure; nothing on success
 *     (results are surfaced at turn-end)
 *   - Any unknown tool name has a safe fallback — never throws
 *   - Bilingual: pass lang='zh' for Chinese-preference channels (e.g. WeChat), 'en' otherwise
 *
 * Channel-agnostic pure functions: used by both WeChat and web-ui.
 */

export type PhraseLang = 'zh' | 'en';

/**
 * Semantic progress phrase shown before a tool call.
 *
 * @param toolName  Internal tool name
 * @param _input    Tool params (reserved — could power "searching for 'keyword'…" in future)
 * @param lang      'zh' for Chinese, 'en' for English (default 'en')
 */
export function semanticToolPhrase(
  toolName: string,
  _input?: Record<string, unknown>,
  lang: PhraseLang = 'en',
): string {
  if (lang === 'zh') return semanticToolPhrase_zh(toolName);
  return semanticToolPhrase_en(toolName);
}

function semanticToolPhrase_en(toolName: string): string {
  switch (toolName) {
    // ── Network ──
    case 'webSearch':
      return 'Searching the web…';
    case 'webFetch':
    case 'http':
      return 'Fetching web content…';
    case 'downloadFile':
      return 'Downloading file…';

    // ── File read ──
    case 'readFile':
      return 'Reading file…';
    case 'glob':
    case 'grep':
      return 'Searching files…';
    case 'inspectPath':
    case 'listDir':
      return 'Checking files…';

    // ── File write ──
    case 'writeFile':
      return 'Writing file…';
    case 'deleteFile':
      return 'Deleting file…';
    case 'moveFile':
      return 'Moving file…';
    case 'patch':
    case 'jsonPatch':
      return 'Editing file…';

    // ── Execute ──
    case 'shell':
    case 'process':
      return 'Running command…';
    case 'planAndExecute':
      return 'Executing task…';
    case 'git':
      return 'Running git operation…';

    // ── Credentials ──
    case 'listCredentialNames':
    case 'saveCredential':
    case 'removeCredential':
      return 'Handling credentials…';

    // ── Memory retrieval ──
    case 'search_notes':
    case 'search_skills':
    case 'recall_sessions':
    case 'memory':
      return 'Searching memory…';
    case 'get_fact':
    case 'list_facts':
      return 'Consulting memory…';
    case 'store_fact':
      return 'Storing note…';

    // ── Skills ──
    case 'use_skill':
      return 'Invoking skill…';
    case 'installSkill':
    case 'uninstallSkill':
      return 'Managing skill…';

    // ── Planning ──
    case 'plan_draft':
    case 'plan_revise':
      return 'Drafting plan…';
    case 'plan_update_step':
    case 'plan_close':
      return 'Updating plan progress…';
    case 'plan_knowledge':
      return 'Recording lesson learned…';
    case 'task_mode_classify':
      return 'Assessing task…';

    // ── Scheduling ──
    case 'schedule_reminder':
    case 'cancel_schedule':
    case 'create_calendar_event':
    case 'list_upcoming':
      return 'Setting up scheduled task…';

    // ── Media ──
    case 'replyWithMedia':
      return 'Sending file…';

    // ── Fallback (echo / env / hash / json / time / askUserQuestion / unknown) ──
    default:
      return 'Working…';
  }
}

function semanticToolPhrase_zh(toolName: string): string {
  switch (toolName) {
    case 'webSearch':
      return '正在搜索网络…';
    case 'webFetch':
    case 'http':
      return '正在抓取网页内容…';
    case 'downloadFile':
      return '正在下载文件…';
    case 'readFile':
      return '正在读取文件…';
    case 'glob':
    case 'grep':
      return '正在搜索文件…';
    case 'inspectPath':
    case 'listDir':
      return '正在检查文件…';
    case 'writeFile':
      return '正在写入文件…';
    case 'deleteFile':
      return '正在删除文件…';
    case 'moveFile':
      return '正在移动文件…';
    case 'patch':
    case 'jsonPatch':
      return '正在修改文件…';
    case 'shell':
    case 'process':
      return '正在执行命令…';
    case 'planAndExecute':
      return '正在执行任务…';
    case 'git':
      return '正在执行 Git 操作…';
    case 'listCredentialNames':
    case 'saveCredential':
    case 'removeCredential':
      return '正在处理凭证…';
    case 'search_notes':
    case 'search_skills':
    case 'recall_sessions':
    case 'memory':
      return '正在检索记忆…';
    case 'get_fact':
    case 'list_facts':
      return '正在查阅记忆…';
    case 'store_fact':
      return '正在记录笔记…';
    case 'use_skill':
      return '正在调用技能…';
    case 'installSkill':
    case 'uninstallSkill':
      return '正在管理技能…';
    case 'plan_draft':
    case 'plan_revise':
      return '正在制定计划…';
    case 'plan_update_step':
    case 'plan_close':
      return '正在更新计划进度…';
    case 'plan_knowledge':
      return '正在沉淀经验…';
    case 'task_mode_classify':
      return '正在评估任务…';
    case 'schedule_reminder':
    case 'cancel_schedule':
    case 'create_calendar_event':
    case 'list_upcoming':
      return '正在设置定时任务…';
    case 'replyWithMedia':
      return '正在发送文件…';
    default:
      return '正在处理…';
  }
}

/**
 * Semantic phrase shown on tool failure. Pairs with semanticToolPhrase; carries ⚠ prefix.
 * Failures are always surfaced (users need to know something went wrong); successes are silent.
 */
export function semanticToolFailPhrase(toolName: string, lang: PhraseLang = 'en'): string {
  if (lang === 'zh') return semanticToolFailPhrase_zh(toolName);
  return semanticToolFailPhrase_en(toolName);
}

function semanticToolFailPhrase_en(toolName: string): string {
  switch (toolName) {
    case 'webSearch':
      return '⚠ Web search did not succeed, retrying…';
    case 'webFetch':
    case 'http':
      return '⚠ Web fetch did not succeed, retrying…';
    case 'downloadFile':
      return '⚠ File download did not succeed, retrying…';
    case 'shell':
    case 'process':
    case 'planAndExecute':
      return '⚠ Command did not succeed, retrying…';
    case 'git':
      return '⚠ Git operation did not succeed, retrying…';
    case 'readFile':
    case 'glob':
    case 'grep':
    case 'inspectPath':
    case 'listDir':
      return '⚠ File lookup did not succeed, retrying…';
    case 'writeFile':
    case 'deleteFile':
    case 'moveFile':
    case 'patch':
    case 'jsonPatch':
      return '⚠ File operation did not succeed, retrying…';
    case 'use_skill':
    case 'installSkill':
    case 'uninstallSkill':
      return '⚠ Skill operation did not succeed, retrying…';
    default:
      return '⚠ Last step did not succeed, retrying…';
  }
}

function semanticToolFailPhrase_zh(toolName: string): string {
  switch (toolName) {
    case 'webSearch':
      return '⚠ 网络搜索未成功,继续尝试…';
    case 'webFetch':
    case 'http':
      return '⚠ 网页抓取未成功,继续尝试…';
    case 'downloadFile':
      return '⚠ 文件下载未成功,继续尝试…';
    case 'shell':
    case 'process':
    case 'planAndExecute':
      return '⚠ 命令执行未成功,继续尝试…';
    case 'git':
      return '⚠ Git 操作未成功,继续尝试…';
    case 'readFile':
    case 'glob':
    case 'grep':
    case 'inspectPath':
    case 'listDir':
      return '⚠ 文件查找未成功,继续尝试…';
    case 'writeFile':
    case 'deleteFile':
    case 'moveFile':
    case 'patch':
    case 'jsonPatch':
      return '⚠ 文件操作未成功,继续尝试…';
    case 'use_skill':
    case 'installSkill':
    case 'uninstallSkill':
      return '⚠ 技能调用未成功,继续尝试…';
    default:
      return '⚠ 上一步未成功,继续尝试…';
  }
}

/** Summarizing-results phrase, used just before the final LLM summary turn. */
export function summarizingPhrase(lang: PhraseLang = 'en'): string {
  return lang === 'zh' ? '⏳ 正在整理结果…' : '⏳ Summarizing results…';
}
