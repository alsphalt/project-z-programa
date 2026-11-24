import 'server-only';
import { jsonb, parseJsonb, query, queryOne } from '../db';
import { uuid } from '../crypto';
import { ApiError } from '../api';
import { assertValidInternalLink } from './assets';
import type { Tutorial, TutorialStep } from './content';

/**
 * Owner-authored tutorials with screenshots.
 *
 * A tutorial is a title, keywords and ordered steps; each step may carry one
 * uploaded image and one internal link. The matcher gives these priority over
 * the built-in text tutorials, so an owner's own screenshots are what a user
 * sees in the conversation.
 */

export interface TutorialStepView {
  id: string;
  index: number;
  title: string;
  body: string;
  assetId: string | null;
  assetUrl: string | null;
  link: string | null;
}

export interface TutorialView {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  published: boolean;
  steps: TutorialStepView[];
  createdAt: string;
  updatedAt: string;
}

interface TutorialRow {
  id: string;
  title: string;
  summary: string | null;
  keywords: unknown;
  is_published: boolean;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  id: string;
  tutorial_id: string;
  idx: number;
  title: string;
  body: string;
  asset_id: string | null;
  link_href: string | null;
}

async function stepsFor(tutorialIds: string[]): Promise<Map<string, StepRow[]>> {
  const map = new Map<string, StepRow[]>();
  if (!tutorialIds.length) return map;
  const rows = await query<StepRow>(
    `select id, tutorial_id, idx, title, body, asset_id, link_href
       from bigbrother_tutorial_steps
      where tutorial_id = any($1::text[])
      order by tutorial_id asc, idx asc`,
    [tutorialIds],
  );
  for (const row of rows) {
    const list = map.get(row.tutorial_id) ?? [];
    list.push(row);
    map.set(row.tutorial_id, list);
  }
  return map;
}

function toView(row: TutorialRow, steps: StepRow[]): TutorialView {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary ?? '',
    keywords: parseJsonb<string[]>(row.keywords, []),
    published: Boolean(row.is_published),
    steps: steps.map((step) => ({
      id: step.id,
      index: Number(step.idx),
      title: step.title,
      body: step.body,
      assetId: step.asset_id,
      assetUrl: step.asset_id ? `/api/bigbrother/assets/${step.asset_id}` : null,
      link: step.link_href,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listTutorials(userId: string): Promise<TutorialView[]> {
  const rows = await query<TutorialRow>(
    'select * from bigbrother_tutorials where user_id = $1 order by updated_at desc',
    [userId],
  );
  const steps = await stepsFor(rows.map((row) => row.id));
  return rows.map((row) => toView(row, steps.get(row.id) ?? []));
}

export async function getTutorial(userId: string, id: string): Promise<TutorialView> {
  const row = await queryOne<TutorialRow>(
    'select * from bigbrother_tutorials where id = $1 and user_id = $2',
    [id, userId],
  );
  if (!row) throw new ApiError('Tutorial not found.', 404, 'tutorial_not_found');
  const steps = await stepsFor([row.id]);
  return toView(row, steps.get(row.id) ?? []);
}

export interface TutorialInput {
  title: string;
  summary?: string;
  keywords?: string[];
  published?: boolean;
  steps: Array<{ title: string; body: string; assetId?: string | null; link?: string | null }>;
}

function validateSteps(steps: TutorialInput['steps']): void {
  if (!steps.length) throw new ApiError('A tutorial needs at least one step.', 400, 'tutorial_empty');
  if (steps.length > 30) throw new ApiError('A tutorial can have at most 30 steps.', 400, 'tutorial_too_long');
  for (const [index, step] of steps.entries()) {
    if (!step.title.trim()) throw new ApiError(`Step ${index + 1} needs a title.`, 400, 'step_title_required');
    if (!step.body.trim()) throw new ApiError(`Step ${index + 1} needs text.`, 400, 'step_body_required');
    assertValidInternalLink(step.link ?? null);
  }
}

export async function createTutorial(userId: string, input: TutorialInput): Promise<TutorialView> {
  validateSteps(input.steps);
  const id = uuid();
  await query(
    `insert into bigbrother_tutorials (id, user_id, title, summary, keywords, is_published)
     values ($1,$2,$3,$4,$5::jsonb,$6)`,
    [
      id,
      userId,
      input.title.trim().slice(0, 160),
      (input.summary ?? '').slice(0, 600),
      jsonb(input.keywords ?? []),
      input.published ?? true,
    ],
  );
  await replaceSteps(userId, id, input.steps);
  return getTutorial(userId, id);
}

async function replaceSteps(
  userId: string,
  tutorialId: string,
  steps: TutorialInput['steps'],
): Promise<void> {
  const owned = await queryOne<{ id: string }>(
    'select id from bigbrother_tutorials where id = $1 and user_id = $2',
    [tutorialId, userId],
  );
  if (!owned) throw new ApiError('Tutorial not found.', 404, 'tutorial_not_found');

  // Only images owned by this account may be attached.
  const assetIds = steps.map((step) => step.assetId).filter((value): value is string => Boolean(value));
  if (assetIds.length) {
    const owned = await query<{ id: string }>(
      'select id from bigbrother_assets where user_id = $1 and id = any($2::text[])',
      [userId, assetIds],
    );
    const allowed = new Set(owned.map((row) => row.id));
    for (const assetId of assetIds) {
      if (!allowed.has(assetId)) throw new ApiError('That image does not belong to your account.', 403, 'asset_forbidden');
    }
  }

  await query('delete from bigbrother_tutorial_steps where tutorial_id = $1', [tutorialId]);
  for (const [index, step] of steps.entries()) {
    await query(
      `insert into bigbrother_tutorial_steps (id, tutorial_id, idx, title, body, asset_id, link_href)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        uuid(),
        tutorialId,
        index,
        step.title.trim().slice(0, 200),
        step.body.slice(0, 4000),
        step.assetId ?? null,
        step.link ?? null,
      ],
    );
  }
}

export async function updateTutorial(
  userId: string,
  id: string,
  input: Partial<TutorialInput>,
): Promise<TutorialView> {
  await getTutorial(userId, id);
  if (input.steps) validateSteps(input.steps);

  const fields: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown, cast = '') => {
    params.push(value);
    fields.push(`${column} = $${params.length}${cast}`);
  };
  if (input.title !== undefined) push('title', input.title.trim().slice(0, 160));
  if (input.summary !== undefined) push('summary', input.summary.slice(0, 600));
  if (input.keywords !== undefined) push('keywords', JSON.stringify(input.keywords), '::jsonb');
  if (input.published !== undefined) push('is_published', input.published);

  if (fields.length) {
    params.push(id, userId);
    await query(
      `update bigbrother_tutorials set ${fields.join(', ')}, updated_at = now()
        where id = $${params.length - 1} and user_id = $${params.length}`,
      params as never[],
    );
  }
  if (input.steps) await replaceSteps(userId, id, input.steps);
  return getTutorial(userId, id);
}

export async function deleteTutorial(userId: string, id: string): Promise<void> {
  const rows = await query<{ id: string }>(
    'delete from bigbrother_tutorials where id = $1 and user_id = $2 returning id',
    [id, userId],
  );
  if (!rows.length) throw new ApiError('Tutorial not found.', 404, 'tutorial_not_found');
}

/** Shape used by the intent matcher; custom tutorials carry their images. */
export function asTutorial(view: TutorialView): Tutorial {
  return {
    slug: view.id,
    title: view.title,
    summary: view.summary,
    keywords: view.keywords,
    steps: view.steps.map((step): TutorialStep => ({
      title: step.title,
      body: step.body,
      assetId: step.assetId ?? undefined,
      link: step.link ?? undefined,
      linkLabel: step.link ? 'Open' : undefined,
    })),
  };
}

export function tutorialImages(tutorial: Tutorial): Array<{ assetId: string; caption: string }> {
  return tutorial.steps
    .filter((step): step is TutorialStep & { assetId: string } => Boolean(step.assetId))
    .map((step) => ({ assetId: step.assetId, caption: step.title }));
}
