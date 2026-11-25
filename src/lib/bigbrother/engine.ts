import 'server-only';
import type { ServerRecord } from '../servers/repo';
import { ABOUT_BIGBROTHER, type Tutorial } from './content';
import type { AnswerAction, AnswerBlock, AssistantAnswerView, Citation } from './shared';
import { detectIntent, type Intent } from './intent';
import { findPages, findSettingsTopics, findTutorials, navCatalogueText } from './nav';
import { asTutorial, listTutorials, type TutorialView } from './tutorials';
import {
  errorsForQuestion,
  pluginFiles,
  projectReport,
  runDiagnostics,
  runtimeFacts,
  searchProject,
  type DiagnosticFinding,
  type ProjectHit,
} from './tools';
import { llmConfig, llmStatus, runToolLoop, type ToolDefinition } from './llm';
import { listConversations, recall, type Conversation } from './memory';

/**
 * BIGBROTHER's answer engine.
 *
 * Order of operations: detect intent → call the real tool for that intent →
 * compose an answer from the returned rows. The language model, when configured,
 * is used only for questions outside the deterministic intents and always with
 * tools, so it cannot answer about this project without reading it.
 */

export type {
  AnswerAction,
  AnswerBlock,
  AssistantAnswerView,
  Citation,
} from './shared';

export interface AssistantAnswer extends AssistantAnswerView {
  intent: Intent;
}

export interface AnswerInput {
  question: string;
  user: { id: string; name: string; email: string; role: string };
  server: ServerRecord | null;
  conversationId: string;
}

const DEFAULT_SUGGESTIONS = [
  'Where can I find my plugins?',
  'How do I restart my bot?',
  'Where can I get the Pterodactyl Client API Key?',
  'Why is my Live Monitor showing Unknown?',
  'Where is my main.js file?',
];

function relativeTime(value: string | null | undefined): string {
  if (!value) return 'never';
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return 'unknown';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function fileOpenHref(path: string, line: number | null): string {
  const params = new URLSearchParams({ path });
  if (line) params.set('line', String(line));
  return `/editor?${params.toString()}`;
}

function imageUrls(tutorial: Tutorial): Array<{ url: string; caption: string }> {
  return tutorial.steps
    .filter((step): step is typeof step & { assetId: string } => Boolean(step.assetId))
    .map((step) => ({ url: `/api/bigbrother/assets/${step.assetId}`, caption: step.title }));
}

function tutorialActionLinks(tutorial: Tutorial): AnswerAction[] {
  return tutorial.steps
    .filter((step) => Boolean(step.link))
    .slice(0, 4)
    .map((step) => ({ label: step.linkLabel ?? step.title, href: step.link, kind: 'navigate' as const }));
}

function dedupeActions(actions: AnswerAction[]): AnswerAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.kind}:${action.href ?? action.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function labelForSource(source: string): string {
  const map: Record<string, string> = {
    whatsapp: 'WhatsApp runtime',
    panel: 'Pterodactyl',
    console: 'Console',
    api: 'Backend API',
    frontend: 'Frontend',
    auth: 'Authentication',
    websocket: 'WebSocket',
    files: 'File manager',
    editor: 'Code editor',
    explorer: 'Project Explorer',
    deployment: 'Deployment',
    packages: 'Packages',
    power: 'Power action',
    storage: 'Storage',
    database: 'Database',
  };
  return map[source] ?? source;
}

function scoreHit(hit: ProjectHit): string {
  if (hit.kind === 'case') return 'command';
  if (hit.kind === 'function') return 'function';
  if (hit.kind === 'file') return 'file';
  return 'content';
}

function customTutorialViews(views: TutorialView[]): Tutorial[] {
  return views.filter((view) => view.published).map(asTutorial);
}

export async function answer(input: AnswerInput): Promise<AssistantAnswer> {
  const { question, server } = input;
  const routed = detectIntent(question);
  const status = llmStatus();
  const serverId = server?.id ?? null;

  const base = {
    text: '',
    blocks: [] as AnswerBlock[],
    citations: [] as Citation[],
    actions: [] as AnswerAction[],
    images: [] as Array<{ url: string; caption: string }>,
    suggestions: DEFAULT_SUGGESTIONS,
    intent: routed.intent,
    engine: 'grounded',
  };

  // ---- identity ----------------------------------------------------------
  if (routed.intent === 'identity') {
    return {
      ...base,
      text: ABOUT_BIGBROTHER.identity,
      blocks: [
        {
          type: 'note',
          tone: 'info',
          text: 'Configured identity of this assistant. I work only on DARKNOTE: the Control Center, your bot project and its diagnostics.',
        },
        { type: 'links', title: 'What I can help with', items: ABOUT_BIGBROTHER.scope.map((item) => ({ label: item, href: '/bigbrother' })) },
      ],
      actions: [{ label: 'What can you do?', kind: 'navigate', href: '/bigbrother' }],
    };
  }

  // ---- capability / greeting --------------------------------------------
  if (routed.intent === 'capability' || routed.intent === 'greeting') {
    const pages = findPages('overview monitor files editor errors settings', 4);
    return {
      ...base,
      text:
        routed.intent === 'greeting'
          ? `Hello ${input.user.name.split(' ')[0]}. I am BIGBROTHER — I know this Control Center, your bot project and the errors it records. Ask me where something is, to find a file, or why something failed.`
          : 'I answer from DARKNOTE itself: the page registry, the file index, the error store and live runtime facts. I will not guess a path or a cause.',
      blocks: [
        { type: 'links', title: 'What I can do', items: ABOUT_BIGBROTHER.scope.map((item) => ({ label: item })) },
        {
          type: 'links',
          title: 'Start here',
          items: pages.map((match) => ({ label: `${match.page.title} — ${match.page.href}`, href: match.page.href, detail: match.page.summary })),
        },
        ...(status.configured
          ? [{ type: 'note' as const, tone: 'info' as const, text: `A language model (${status.model}) is connected for out-of-scope questions. Navigation, file and error answers are still produced from DARKNOTE data so they cannot drift.` }]
          : []),
      ],
      actions: pages.map((match) => ({ label: match.page.title, href: match.page.href, kind: 'navigate' as const })),
    };
  }

  // ---- memory recall -----------------------------------------------------
  if (routed.intent === 'memory_recall') {
    const history = await recall(input.user.id, { excludeConversationId: input.conversationId, serverId });
    if (!history.hasHistory || !history.lastConversation) {
      return {
        ...base,
        text: 'I do not have a saved earlier conversation for this account, so there is nothing truthful to continue from. I only remember conversations that were actually stored.',
        blocks: [
          {
            type: 'note',
            tone: 'warn',
            text: 'Nothing was found in your conversation history. Once you chat with me, each conversation is saved to your account and can be resumed from the sidebar.',
          },
        ],
        actions: [{ label: 'Open conversations', href: '/bigbrother', kind: 'navigate' }],
      };
    }
    const lastUser = [...history.exchanges].reverse().find((item) => item.role === 'user');
    const lastAssistant = [...history.exchanges].reverse().find((item) => item.role === 'assistant');
    return {
      ...base,
      text: [
        `Your most recent saved conversation is “${history.lastConversation.title}” (${relativeTime(history.lastConversation.updatedAt)}, ${history.lastConversation.messageCount} message(s)).`,
        lastUser ? `\nYou asked: “${lastUser.content.slice(0, 400)}”` : '',
        lastAssistant ? `\nI answered: “${lastAssistant.content.slice(0, 700)}${lastAssistant.content.length > 700 ? '…' : ''}”` : '',
        '\nWe can continue from there — ask the follow-up and I will use this context.',
      ]
        .filter(Boolean)
        .join('\n'),
      blocks: [
        {
          type: 'links',
          title: 'Saved context',
          items: history.facts.slice(0, 6).map((fact) => ({
            label: `${fact.key}: ${String(typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value)).slice(0, 180)}`,
            detail: `updated ${relativeTime(fact.updatedAt)}`,
          })),
        },
        ...(history.lastConversation
          ? [{ type: 'note' as const, tone: 'info' as const, text: `Conversation id ${history.lastConversation.id}. Open it from the conversation list to read the full thread.` }]
          : []),
      ],
      citations: [
        { label: 'Conversation storage', detail: `bigbrother_conversations/${history.lastConversation.id}` },
      ],
      actions: [{ label: 'Resume that conversation', href: `/bigbrother?c=${history.lastConversation.id}`, kind: 'navigate' }],
    };
  }

  // ---- file search -------------------------------------------------------
  if (routed.intent === 'file_search') {
    if (!server) {
      return {
        ...base,
        text: 'No server is connected, so there is no project to search. Connect a Pterodactyl server in Admin Settings and run Server Discovery.',
        actions: [{ label: 'Admin Settings', href: '/settings', kind: 'navigate' }],
      };
    }
    const term = routed.searchTerm || question;
    if (/plugin/i.test(question) && /(all|find|list|show)/i.test(question)) {
      const plugins = await pluginFiles(server.id);
      if (!plugins.dirs.length && !plugins.files.length) {
        return {
          ...base,
          text: 'The index has no plugin folder or plugin file for this server, so I will not name a path. Plugins live inside the project as folders — open Project Explorer and use the folder breadcrumb, or index the tree first so I can list the real paths.',
          blocks: [
            {
              type: 'steps',
              title: 'Where plugins live',
              steps: [
                { title: 'Open Project Explorer', body: 'The file manager shows the real server tree for the active server.', link: '/files', linkLabel: 'Open Project Explorer' },
                { title: 'Tap the folder icon', body: 'Use the folder breadcrumb at the top to move into the plugins directory (often /plugins or /commands).', link: '/files?path=%2Fplugins', linkLabel: 'Try /plugins' },
                { title: 'Index it for exact paths', body: 'Server Discovery walks the filesystem so I can answer with real paths and line numbers instead of a guess.', link: '/discovery', linkLabel: 'Run Server Discovery' },
              ],
            },
            { type: 'note', tone: 'warn', text: 'No plugins folder is indexed yet, so this is the navigation path — not a claimed file list.' },
          ],
          actions: [
            { label: 'Open Project Explorer', href: '/files', kind: 'explore' },
            { label: 'Run Server Discovery', href: '/discovery', kind: 'navigate' },
          ],
        };
      }
      return {
        ...base,
        text: `I found ${plugins.dirs.length} plugin folder(s) and ${plugins.files.length} plugin file(s) in the index for ${server.name}. These are real paths from the last scan.`,
        blocks: [
          ...(plugins.dirs.length
            ? [{ type: 'links' as const, title: 'Plugin folders', items: plugins.dirs.map((dir) => ({ label: dir, href: `/files?path=${encodeURIComponent(dir)}` })) }]
            : []),
          {
            type: 'files',
            title: 'Plugin files',
            items: plugins.files.map((hit) => ({
              path: hit.path,
              line: hit.line,
              kind: 'file',
              snippet: null,
              openHref: hit.openHref,
              explorerHref: hit.explorerHref,
            })),
          },
        ],
        citations: [{ label: 'File index', detail: `server ${server.id}` }],
        actions: [
          ...plugins.dirs.slice(0, 2).map((dir) => ({ label: `Open ${dir}`, href: `/files?path=${encodeURIComponent(dir)}`, kind: 'explore' as const })),
          { label: 'Open Project Explorer', href: '/files', kind: 'explore' },
        ],
      };
    }

    const result = await searchProject(server, term, 8);
    if (!result.hits.length) {
      return {
        ...base,
        text: `I searched ${result.indexedFiles} indexed file(s) for “${term}” and found nothing. ${result.notes.join(' ')}`,
        blocks: [
          { type: 'note', tone: 'warn', text: 'No path is shown because none matched. I will not claim a file exists without checking.' },
          { type: 'links', title: 'Widen the search', items: [{ label: 'Global Search (text, regex, AST)', href: '/search' }, { label: 'Project Explorer', href: '/files' }] },
        ],
        actions: [
          { label: 'Open Global Search', href: '/search', kind: 'navigate' },
          { label: 'Open Project Explorer', href: '/files', kind: 'explore' },
        ],
      };
    }

    const primary = result.hits[0];
    return {
      ...base,
      text: `I checked the index and found ${result.hits.length} match(es) for “${term}”. The closest is ${primary.path}${primary.line ? ` at line ${primary.line}` : ''}${primary.label ? ` (${primary.kind} “${primary.label}”)` : ''}.`,
      blocks: [
        {
          type: 'files',
          title: 'Real paths from the index',
          items: result.hits.map((hit) => ({
            path: hit.path,
            label: hit.label,
            line: hit.line,
            kind: scoreHit(hit),
            snippet: hit.snippet,
            openHref: hit.openHref,
            explorerHref: hit.explorerHref,
          })),
        },
        ...(result.notes.length ? [{ type: 'note' as const, tone: 'info' as const, text: result.notes.join(' ') }] : []),
      ],
      citations: [
        { label: 'File index', detail: `${result.indexedFiles} file(s) indexed` },
        ...(result.snapshotAt ? [{ label: 'Content snapshot', detail: result.snapshotAt }] : []),
      ],
      actions: dedupeActions([
        { label: 'Open the file', href: primary.openHref, kind: 'open-file' },
        { label: 'Show in Project Explorer', href: primary.explorerHref, kind: 'explore' },
        { label: 'Global Search', href: '/search', kind: 'navigate' },
      ]),
    };
  }

  // ---- error explanation -------------------------------------------------
  if (routed.intent === 'error_explain') {
    const answerSet = await errorsForQuestion(serverId, question);
    const facts = server ? await runtimeFacts(server.id) : null;
    const blocks: AnswerBlock[] = [];

    if (answerSet.matched.length) {
      blocks.push({
        type: 'errors',
        title: `${answerSet.matched.length} matching record(s)`,
        items: answerSet.matched.map((error) => ({
          id: error.id,
          title: error.title,
          code: error.code,
          severity: error.severity,
          source: labelForSource(error.source),
          filePath: error.filePath,
          line: error.line,
          rootCause: error.rootCause,
          recommendation: error.recommendation,
          href: `/errors?focus=${error.id}`,
          occurrences: error.occurrences,
        })),
      });
      const first = answerSet.matched[0];
      blocks.push({
        type: 'note',
        tone: first.severity === 'critical' ? 'bad' : 'warn',
        text: `Why this happened: ${first.why}`,
      });
      if (first.evidence.length) {
        blocks.push({ type: 'note', tone: 'info', text: `Evidence: ${first.evidence.slice(0, 3).join(' · ')}` });
      }
    } else {
      blocks.push({
        type: 'note',
        tone: 'warn',
        text: `${answerSet.note} I will not guess a cause; the runtime facts below are what DARKNOTE actually knows right now.`,
      });
    }

    if (facts) {
      blocks.push({
        type: 'diagnostics',
        title: 'Live runtime facts',
        at: new Date().toISOString(),
        findings: [
          {
            id: 'container',
            label: 'Container',
            status: facts.containerState === 'running' ? 'ok' : facts.containerState === 'unknown' ? 'unknown' : 'warn',
            detail: `Panel reports “${facts.containerState}”.`,
            href: '/monitor',
          },
          {
            id: 'whatsapp',
            label: 'WhatsApp',
            status: facts.whatsappState === 'connected' ? 'ok' : facts.whatsappState === 'unknown' ? 'unknown' : 'fail',
            detail:
              facts.whatsappState === 'unknown'
                ? 'No connection event has been observed for the current process and no status file was read. Unknown is accurate.'
                : `State “${facts.whatsappState}”${facts.whatsappSignal ? ` — ${facts.whatsappSignal.slice(0, 150)}` : ''}.`,
            href: '/monitor',
          },
          {
            id: 'console',
            label: 'Console',
            status: facts.consoleState === 'live' ? 'ok' : facts.consoleState === 'error' ? 'fail' : 'warn',
            detail: `${facts.consoleState}; ${facts.bufferedLines} line(s) buffered${facts.consoleError ? ` — ${facts.consoleError}` : ''}.`,
            href: '/console',
          },
          {
            id: 'deploy',
            label: 'Last deployment',
            status: facts.lastDeployment?.status === 'failed' ? 'fail' : 'ok',
            detail: facts.lastDeployment ? `${facts.lastDeployment.status} at ${facts.lastDeployment.at}` : 'none recorded',
            href: '/deployments',
          },
        ],
      });
    }

    if (!server) {
      blocks.push({ type: 'note', tone: 'info', text: 'No server is selected, so panel and console facts are unavailable. Global API, auth and browser errors are still shown above.' });
    }

    const first = answerSet.matched[0];
    return {
      ...base,
      text: first
        ? `${first.title}. ${first.rootCause} Recommended fix: ${first.recommendation}`
        : `${answerSet.note}${facts ? ` Right now the panel reports the container as “${facts.containerState}” and WhatsApp as “${facts.whatsappState}”.` : ''}`,
      blocks,
      citations: [
        { label: 'Error store', detail: `${answerSet.activeCount} active record(s)` },
        ...(first?.filePath ? [{ label: 'Affected file', detail: `${first.filePath}${first.line ? `:${first.line}` : ''}` }] : []),
      ],
      actions: dedupeActions([
        { label: 'Open Error Center', href: '/errors', kind: 'navigate' },
        ...(first ? [{ label: 'Open this error', href: `/errors?focus=${first.id}`, kind: 'navigate' as const }] : []),
        ...(first?.filePath ? [{ label: 'Open affected file', href: fileOpenHref(first.filePath, first.line), kind: 'open-file' as const }] : []),
        { label: 'Open Terminal & Logs', href: '/console', kind: 'navigate' },
        { label: 'Run a diagnostic scan', kind: 'scan' },
      ]),
    };
  }

  // ---- diagnostics / report ---------------------------------------------
  if (routed.intent === 'diagnostics') {
    const wantsReport = /\breport\b/i.test(question);
    if (wantsReport) {
      const markdown = await projectReport(server);
      return {
        ...base,
        text: `I generated the report from stored runtime facts${server ? ` for ${server.name}` : ''}. Nothing in it is estimated; missing sources are named as missing.`,
        blocks: [{ type: 'report', title: 'DARKNOTE report', markdown }],
        citations: [{ label: 'Sources', detail: 'bot_status, file_indexes, deployments, error_intel_events' }],
        actions: [
          { label: 'Error Center', href: '/errors', kind: 'navigate' },
          { label: 'Live Monitor', href: '/monitor', kind: 'navigate' },
          { label: 'Run a fresh scan', kind: 'scan' },
        ],
      };
    }
    const result = await runDiagnostics(server);
    const failing = result.findings.filter((finding) => finding.status === 'fail').length;
    const unknown = result.findings.filter((finding) => finding.status === 'unknown').length;
    return {
      ...base,
      text: `I ran ${result.findings.length} checks. ${failing} failing, ${unknown} unknown. Unknown means the source could not report a value — it is not treated as healthy.`,
      blocks: [{ type: 'diagnostics', title: 'Diagnostic result', at: result.at, findings: result.findings }],
      citations: [{ label: 'Checked at', detail: result.at }],
      actions: [
        { label: 'Open Error Center', href: '/errors', kind: 'navigate' },
        { label: 'Run a full scan', kind: 'scan' },
        { label: 'Live Monitor', href: '/monitor', kind: 'navigate' },
      ],
    };
  }

  // ---- navigation --------------------------------------------------------
  const pages = findPages(question, 3);
  const customTutorials = await listTutorials(input.user.id).then(customTutorialViews).catch(() => []);
  const tutorialMatches = findTutorials(question, customTutorials, 2);

  if (routed.intent === 'navigation' || routed.intent === 'guide' || routed.intent === 'settings') {
    const settingTopics = findSettingsTopics(question, 2);

    if (routed.intent === 'settings' && settingTopics.length) {
      const topic = settingTopics[0].topic;
      return {
        ...base,
        text: `${topic.label}: ${topic.explanation}`,
        blocks: [
          {
            type: 'links',
            title: 'Settings involved',
            items: settingTopics.map((entry) => ({
              label: entry.topic.label,
              href: entry.topic.link,
              detail: entry.topic.explanation,
            })),
          },
        ],
        citations: [{ label: 'Admin Settings', detail: topic.link }],
        actions: [{ label: 'Open Admin Settings', href: '/settings', kind: 'navigate' }],
      };
    }

    if (tutorialMatches.length) {
      const match = tutorialMatches[0];
      const tutorial = match.tutorial;
      return {
        ...base,
        text: `${tutorial.summary}\n\nHere is the step-by-step path. Every link below is a page in this Control Center.`,
        blocks: [
          {
            type: 'steps',
            title: tutorial.title,
            steps: tutorial.steps.map((step) => ({
              title: step.title,
              body: step.body,
              link: step.link ?? null,
              linkLabel: step.linkLabel ?? (step.link ? 'Open' : null),
            })),
          },
          ...(tutorialMatches[1]
            ? [{ type: 'note' as const, tone: 'info' as const, text: `Related: ${tutorialMatches[1].tutorial.title}` }]
            : []),
          {
            type: 'note',
            tone: 'info',
            text:
              match.source === 'custom'
                ? 'This tutorial and its screenshots were added by the owner of this account.'
                : 'This is the built-in procedure. Upload your own screenshots in BIGBROTHER → Tutorials to replace it with your images.',
          },
        ],
        images: imageUrls(tutorial),
        citations: [{ label: match.source === 'custom' ? 'Owner tutorial' : 'Built-in procedure', detail: tutorial.title }],
        actions: dedupeActions(tutorialActionLinks(tutorial)),
      };
    }

    if (pages.length) {
      const primary = pages[0].page;
      return {
        ...base,
        text: `That lives in ${primary.title} (${primary.href}). ${primary.summary}`,
        blocks: [
          {
            type: 'links',
            title: 'Where to go',
            items: pages.map((match) => ({
              label: `${match.page.title} — ${match.page.href}`,
              href: match.page.href,
              detail: match.page.commonTasks.join(' · '),
            })),
          },
          {
            type: 'steps',
            title: `In ${primary.title}`,
            steps: primary.details.map((detail, index) => ({ title: `Step ${index + 1}`, body: detail })),
          },
          ...(settingTopics.length
            ? [{
                type: 'links' as const,
                title: 'Related settings',
                items: settingTopics.map((entry) => ({ label: entry.topic.label, href: entry.topic.link, detail: entry.topic.explanation.slice(0, 180) })),
              }]
            : []),
        ],
        citations: [{ label: 'Navigation registry', detail: `${primary.href} → ${primary.title}` }],
        actions: dedupeActions(pages.map((match) => ({ label: `Open ${match.page.title}`, href: match.page.href, kind: 'navigate' as const }))),
      };
    }

    if (settingTopics.length) {
      const topic = settingTopics[0].topic;
      return {
        ...base,
        text: `${topic.label}: ${topic.explanation}`,
        blocks: [
          {
            type: 'links',
            title: 'Settings involved',
            items: settingTopics.map((entry) => ({ label: entry.topic.label, href: entry.topic.link, detail: entry.topic.explanation })),
          },
        ],
        citations: [{ label: 'Admin Settings', detail: topic.link }],
        actions: [{ label: 'Open Admin Settings', href: '/settings', kind: 'navigate' }],
      };
    }
  }

  // ---- general (model-assisted, tool grounded) ---------------------------
  if (llmConfig() && routed.intent === 'general') {
    try {
      const tools = buildTools(server);
      const result = await runToolLoop({
        system: [
          `You are ${ABOUT_BIGBROTHER.name}, the assistant of the DARKNOTE Control Center.`,
          ABOUT_BIGBROTHER.identity,
          'You only help with DARKNOTE: this Control Center, the WhatsApp bot project, its files, deployments and errors.',
          'Rules: never invent a file path, command, setting or page. Use a tool to check. If a tool returns nothing, say so.',
          'Never claim to have changed production. Changes are proposed and must be confirmed by the user in the Error Center or Code Editor.',
          'Answer in the language of the question, concise, with Markdown. Do not mention tool names or internal ids.',
          'Pages you may reference:',
          navCatalogueText(),
        ].join('\n'),
        messages: [{ role: 'user', content: question }],
        tools,
        callTool: async (name, args) => {
          if (!server) return { error: 'No server is connected.' };
          if (name === 'search_files') return searchProject(server, String(args.query ?? question), 8);
          if (name === 'list_errors') return errorsForQuestion(server.id, String(args.query ?? question));
          if (name === 'runtime_status') return runtimeFacts(server.id);
          if (name === 'find_page') return findPages(String(args.query ?? question), 3).map((match) => match.page);
          return { error: `Unknown tool ${name}` };
        },
      });
      return {
        ...base,
        text: result.text || 'The model returned an empty answer; ask again or try a more specific question.',
        engine: `model:${result.model}`,
        citations: [
          { label: 'Model', detail: result.model },
          ...(result.toolCalls.length
            ? [{ label: 'Grounding', detail: `${result.toolCalls.length} data call(s): ${[...new Set(result.toolCalls.map((call) => call.name))].join(', ')}` }]
            : [{ label: 'Grounding', detail: 'No data call was needed for this answer' }]),
        ],
        actions: [{ label: 'Open Error Center', href: '/errors', kind: 'navigate' }],
        suggestions: DEFAULT_SUGGESTIONS,
      };
    } catch (error) {
      return {
        ...base,
        text: `The language model could not answer (${error instanceof Error ? error.message : String(error)}). I can still answer from DARKNOTE data: ask where a feature is, to find a file, or why something failed.`,
        blocks: [
          {
            type: 'note',
            tone: 'warn',
            text: 'No answer was invented to cover the provider failure. Deterministic answers remain available.',
          },
          {
            type: 'links',
            title: 'Try',
            items: DEFAULT_SUGGESTIONS.slice(0, 4).map((suggestion) => ({ label: suggestion })),
          },
        ],
      };
    }
  }

  // ---- honest fallback ---------------------------------------------------
  const fallbackPages = pages.length ? pages : findPages('overview settings errors', 3);
  return {
    ...base,
    text:
      'I can answer about objects inside DARKNOTE, but that question did not match a page, a tutorial, a file or a recorded error. I will not guess an answer about this project.',
    blocks: [
      {
        type: 'links',
        title: 'Questions I can answer precisely',
        items: DEFAULT_SUGGESTIONS.map((suggestion) => ({ label: suggestion })),
      },
      ...(fallbackPages.length
        ? [{
            type: 'links' as const,
            title: 'Or open a section',
            items: fallbackPages.map((match) => ({ label: match.page.title, href: match.page.href, detail: match.page.summary })),
          }]
        : []),
      ...(llmStatus().configured
        ? [{ type: 'note' as const, tone: 'info' as const, text: 'A model is configured, but this question stayed outside the DARKNOTE scope I can verify.' }]
        : [{ type: 'note' as const, tone: 'info' as const, text: 'No language model is configured (DARKNOTE_AI_API_KEY). Answers come from DARKNOTE data only — which is why they are verifiable.' }]),
    ],
    actions: fallbackPages.map((match) => ({ label: match.page.title, href: match.page.href, kind: 'navigate' as const })),
  };
}

function buildTools(server: ServerRecord | null): ToolDefinition[] {
  void server;
  return [
    {
      name: 'search_files',
      description: 'Search the indexed DARKNOTE project for files, commands, functions or text. Returns real paths and line numbers.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Text, file name, command or function to find' } },
        required: ['query'],
      },
    },
    {
      name: 'list_errors',
      description: 'Read captured errors and diagnostics from the DARKNOTE Error Intelligence store.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What the user is asking about' } },
        required: ['query'],
      },
    },
    {
      name: 'runtime_status',
      description: 'Read the stored container, WhatsApp, console, index and deployment facts for the active server.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'find_page',
      description: 'Find the Control Center page that owns a feature. Returns real page titles and hrefs.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Feature or page the user is looking for' } },
        required: ['query'],
      },
    },
  ];
}

/** Conversation list helper used by the page's sidebar. */
export async function conversationList(userId: string): Promise<Conversation[]> {
  return listConversations(userId, 40);
}
