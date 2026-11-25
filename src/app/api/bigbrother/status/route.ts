import { ok, route } from '@/lib/api';
import { llmStatus } from '@/lib/bigbrother/llm';
import { listConversations, listMemory } from '@/lib/bigbrother/memory';
import { listTutorials } from '@/lib/bigbrother/tutorials';
import { NAV_PAGES } from '@/lib/bigbrother/content';
import { unresolvedCriticalCount } from '@/lib/errors/store';
import { serversVisibleTo } from '@/lib/servers/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What the assistant page shows about its own capabilities. */
export const GET = route({ permission: null }, async ({ user }) => {
  const [conversations, tutorials, memory] = await Promise.all([
    listConversations(user.id, 50),
    listTutorials(user.id),
    listMemory(user.id),
  ]);

  // Problem counts follow the caller's own server grants, not the global total.
  const visible = ['owner', 'admin'].includes(user.role)
    ? null
    : (await serversVisibleTo(user)).map((server) => server.id);
  const openProblems =
    visible === null
      ? await unresolvedCriticalCount(null)
      : (await Promise.all(visible.map((id) => unresolvedCriticalCount(id)))).reduce((sum, value) => sum + value, 0);

  const engine = llmStatus();
  return ok({
    engine: {
      configured: engine.configured,
      model: engine.model,
      host: engine.host,
      mode: engine.configured ? 'model + grounded tools' : 'grounded only',
    },
    counts: {
      conversations: conversations.length,
      tutorials: tutorials.length,
      memoryFacts: memory.length,
      pages: NAV_PAGES.length,
      openProblems,
    },
    scope: [
      'Control Center navigation with real page links',
      'Project file, command and function search from the index',
      'Error explanations from captured diagnostics',
      'Guided tutorials, including owner-uploaded screenshots',
      'Conversation memory scoped to your account',
    ],
  });
});
