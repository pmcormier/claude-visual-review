// Shared shapes for the work tree. Types only; no runtime code.

/**
 * @typedef {{
 *   id: string,
 *   n: number|null,
 *   title: string,
 *   status: 'done'|'doing'|'next'|'waiting',
 *   size: string|null,
 *   sessionId: string|null,
 *   startedMs: number|null,
 *   doneMs: number|null,
 *   ticked: {done: number, total: number}|null
 * }} Task
 */

/**
 * @typedef {{
 *   id: string,
 *   source: 'worklog'|'plan'|'bmad'|'inbox',
 *   title: string,
 *   file: string|null,
 *   tasks: Task[]
 * }} Epic
 */

export {};
