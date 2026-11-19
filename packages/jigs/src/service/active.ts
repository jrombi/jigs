// An inactive trigger or schedule is neither run nor checked: the service and doctor see only these.

import type { Factory } from "../workflow/factory.ts";

const active = <T extends { active: boolean }>(entries: Record<string, T> = {}) =>
  Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.active));

/** The factory with only its active triggers and schedules. */
export function activeFactory(factory: Factory): Factory {
  return {
    ...factory,
    schedules: active(factory.schedules),
    triggers: active(factory.triggers),
  };
}

/** The names of the factory's triggers that are not active in this copy. */
export function inactiveTriggerNames(factory: Factory): string[] {
  return inactiveNames(factory.triggers);
}

/** The names of the factory's schedules that are not active in this copy. */
export function inactiveScheduleNames(factory: Factory): string[] {
  return inactiveNames(factory.schedules);
}

function inactiveNames<T extends { active: boolean }>(entries: Record<string, T> = {}): string[] {
  return Object.entries(entries)
    .filter(([, entry]) => !entry.active)
    .map(([name]) => name);
}
