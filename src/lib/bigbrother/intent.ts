/**
 * Intent routing for BIGBROTHER.
 *
 * The assistant is deliberately not a general-purpose chatbot: every intent
 * below maps to a tool over DARKNOTE's own data. The router is deterministic so
 * navigation and file answers cannot drift, and so the behaviour is testable.
 */

export type Intent =
  | 'identity'
  | 'memory_recall'
  | 'error_explain'
  | 'file_search'
  | 'navigation'
  | 'guide'
  | 'diagnostics'
  | 'settings'
  | 'capability'
  | 'greeting'
  | 'general';

export interface IntentResult {
  intent: Intent;
  /** Query used for file search (already stripped of filler). */
  searchTerm: string;
  reason: string;
}

const FILE_NOUNS =
  /\b(file|files|folder|folders|directory|\.js|\.cjs|\.mjs|\.ts|\.json|\.env|plugin|plugins|function|functions|command|commands|handler|main\.js|index\.js|welcome|download system|code)\b/i;

const PAGE_NOUNS =
  /\b(page|pages|section|screen|menu|tab|button|dashboard|monitor|discovery|sync|deployments|backups|downloads|console|settings|errors?|editor|cases?)\b/i;

function stripFiller(question: string): string {
  return question
    .replace(/^\s*(hey |hi |please |can you |could you )/i, '')
    .replace(/\b(where (is|are|can i find)|find|locate|show me|search for|look for|which file (has|contains)|what file (has|contains)|in which file)\b/gi, ' ')
    .replace(/\b(my|the|a|an|all|of|for|me|please|file|files)\b/gi, ' ')
    .replace(/["'`]/g, ' ')
    .replace(/\s+([?.!,;:])/g, '$1')
    .replace(/[?.!,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectIntent(question: string): IntentResult {
  const q = question.trim();
  const lower = q.toLowerCase();
  const searchTerm = stripFiller(q);

  if (/\b(who (created|made|built|owns|is behind)|who'?s your (owner|creator)|your (owner|creator)|who are you)\b/i.test(lower)) {
    return { intent: 'identity', searchTerm, reason: 'Creator/owner question' };
  }

  if (
    /\b(where did i (stop|leave|end)|what did we (discuss|talk about)|continue (from )?(where|our)|last (conversation|time|question)|do you remember|what do you remember)\b/i.test(
      lower,
    )
  ) {
    return { intent: 'memory_recall', searchTerm, reason: 'Conversation recall' };
  }

  if (/\bunknown\b/i.test(lower) && /\b(monitor|status|whatsapp|badge|live)\b/i.test(lower)) {
    return { intent: 'guide', searchTerm, reason: 'Status badge explanation' };
  }

  if (
    /\b(why|what caused|explain|diagnose)\b.{0,40}\b(error|fail|failed|failing|offline|crash|crashed|not working|broken|stuck|disconnect|405|401|403|429|500|502)\b/i.test(
      lower,
    ) ||
    /\b(what|why)('s| is) (wrong|happening) (with|to)\b/i.test(lower) ||
    /\b(405|502|econnrefused|module_not_found|cannot find module|unhandled ?rejection)\b/i.test(lower) ||
    /\b(bot|whatsapp|deployment|deploy|restart|panel)\b.{0,30}\b(fail|failed|failing|offline|down|error|crashed|not (starting|working))\b/i.test(
      lower,
    ) ||
    /\b(error|errors)\b.{0,20}\b(explain|mean|fix|why)\b/i.test(lower)
  ) {
    return { intent: 'error_explain', searchTerm, reason: 'Failure question' };
  }

  if (/\b(run (a )?(check|diagnostic|scan)|diagnose (the )?(system|server|bot)|status report|generate (a )?(report|summary)|health check)\b/i.test(lower)) {
    return { intent: 'diagnostics', searchTerm, reason: 'Explicit diagnostic request' };
  }

  if (
    (/\b(find|locate|which file|what file|where is|where are|show me|search|list|get all)\b/i.test(lower) &&
      FILE_NOUNS.test(lower)) ||
    /\b(find|show|list) (me )?(all )?(the )?(plugins|commands|files)\b/i.test(lower) ||
    /\.(js|cjs|mjs|ts|json)\b/i.test(lower)
  ) {
    // "Where is the Error Center" is navigation, not a file lookup.
    if (PAGE_NOUNS.test(lower) && !/\.(js|cjs|mjs|ts|json)\b/i.test(lower) && !/\b(plugin|function|command|handler)\b/i.test(lower)) {
      return { intent: 'navigation', searchTerm, reason: 'Page noun without a file token' };
    }
    return { intent: 'file_search', searchTerm, reason: 'File-oriented request' };
  }

  if (/\b(how (do|can|to)|steps|step by step|guide|tutorial|walk me through|set ?up|configure|connect|install|pair)\b/i.test(lower)) {
    return { intent: 'guide', searchTerm, reason: 'Procedural question' };
  }

  if (/\b(where (can|do|is|are)|which page|take me|navigate|go to|open the|show me the)\b/i.test(lower)) {
    return { intent: 'navigation', searchTerm, reason: 'Location question' };
  }

  if (/\b(setting|settings|option|policy|limit|threshold|hours|timeout|permission)\b/i.test(lower)) {
    return { intent: 'settings', searchTerm, reason: 'Settings question' };
  }

  if (/\b(what can you do|capabilities|what do you know|how can you help|what are you)\b/i.test(lower)) {
    return { intent: 'capability', searchTerm, reason: 'Capability question' };
  }

  if (/^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/i.test(lower)) {
    return { intent: 'greeting', searchTerm, reason: 'Greeting' };
  }

  return { intent: 'general', searchTerm, reason: 'No deterministic intent matched' };
}
