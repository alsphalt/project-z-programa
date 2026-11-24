import { pageExists } from '../errors/routes';
import {
  BUILTIN_TUTORIALS,
  NAV_PAGES,
  SETTINGS_TOPICS,
  type NavPage,
  type SettingsTopic,
  type Tutorial,
} from './content';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'my', 'me', 'i', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could',
  'how', 'where', 'what', 'why', 'when', 'which', 'who', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
  'please', 'help', 'find', 'show', 'get', 'go', 'open', 'need', 'want', 'it', 'this', 'that', 'with',
]);

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function score(query: string, tokens: string[], phrases: string[], weights: number[] = []): number {
  const lowerQuery = ` ${query.toLowerCase()} `;
  let total = 0;
  phrases.forEach((phrase, index) => {
    if (!phrase) return;
    const weight = weights[index] ?? 1;
    if (lowerQuery.includes(phrase.toLowerCase())) total += 4 * weight;
    else {
      const phraseTokens = tokenize(phrase);
      const overlap = phraseTokens.filter((token) => tokens.includes(token)).length;
      if (overlap) total += overlap * weight;
    }
  });
  return total;
}

export interface PageMatch {
  page: NavPage;
  score: number;
}

export function findPages(question: string, limit = 3): PageMatch[] {
  const tokens = tokenize(question);
  const matches = NAV_PAGES.map((page) => ({
    page,
    score: score(question, tokens, [page.title, ...page.keywords, page.summary], [3, 2, 2, 2, 2, 2, 1]),
  }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score);
  return matches.slice(0, limit);
}

export interface TutorialMatch {
  tutorial: Tutorial;
  score: number;
  source: 'built-in' | 'custom';
}

export function findTutorials(
  question: string,
  custom: Tutorial[] = [],
  limit = 2,
): TutorialMatch[] {
  const tokens = tokenize(question);
  const all: TutorialMatch[] = [
    ...custom.map((tutorial) => ({ tutorial, source: 'custom' as const, score: 0 })),
    ...BUILTIN_TUTORIALS.map((tutorial) => ({ tutorial, source: 'built-in' as const, score: 0 })),
  ];

  for (const entry of all) {
    const { tutorial } = entry;
    const base = score(question, tokens, [tutorial.title, ...tutorial.keywords, tutorial.summary], [3, 2, 2, 2, 1]);
    // Owner-uploaded tutorials win on the same topic: they carry that account's
    // own screenshots, while still needing a real topical match to appear.
    entry.score = base * (entry.source === 'custom' ? 1.35 : 1);
  }

  return all
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function findSettingsTopics(question: string, limit = 3): Array<{ topic: SettingsTopic; score: number }> {
  const tokens = tokenize(question);
  return SETTINGS_TOPICS.map((topic) => ({
    topic,
    score: score(question, tokens, [topic.label, ...topic.keywords], [2, 2, 2]),
  }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function pageById(id: string): NavPage | undefined {
  return NAV_PAGES.find((page) => page.id === id);
}

/**
 * Every advertised link must resolve to a real page file. The tests fail the
 * build when this returns anything, so a dead link cannot ship.
 */
export function invalidNavHrefs(): string[] {
  const hrefs = new Set<string>();
  for (const page of NAV_PAGES) hrefs.add(page.href.split('?')[0]);
  for (const tutorial of BUILTIN_TUTORIALS) {
    for (const step of tutorial.steps) {
      if (step.link) hrefs.add(step.link.split('?')[0]);
    }
  }
  for (const topic of SETTINGS_TOPICS) hrefs.add(topic.link.split('?')[0]);
  return [...hrefs].filter((href) => !pageExists(href));
}

/** Compact catalogue used in LLM prompts (no invented content). */
export function navCatalogueText(): string {
  return NAV_PAGES.map(
    (page) => `- ${page.title} (${page.href}): ${page.summary} Tasks: ${page.commonTasks.join('; ')}`,
  ).join('\n');
}
