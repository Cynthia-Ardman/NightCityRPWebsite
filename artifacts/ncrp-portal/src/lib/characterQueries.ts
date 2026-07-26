import type { QueryClient } from "@tanstack/react-query";
import {
  getGetCharacterQueryKey,
  getGetCharacterInventoryQueryKey,
  getListMyCharactersQueryKey,
  getListArchiveCharactersQueryKey,
  getGetArchiveCharacterQueryKey,
  getListPublicCharactersQueryKey,
  getGetPublicCharacterQueryKey,
  getListPublicCharacterTagsQueryKey,
} from "@workspace/api-client-react";

// Invalidate the standard character-domain query set after any mutation that
// changes a character (edits, cyberware saves, tag edits, deletes). One place
// to keep the list, so a new character-derived view can't be forgotten at one
// of the scattered mutation sites. List keys are prefix-matched (no params) so
// every filtered variation refetches. Returns a promise so callers that need
// to sequence (e.g. before a toast) can await it; fire-and-forget is also fine.
export function invalidateCharacterQueries(
  qc: QueryClient,
  characterId?: number,
): Promise<unknown> {
  const jobs: Promise<unknown>[] = [
    qc.invalidateQueries({ queryKey: getListMyCharactersQueryKey() }),
    qc.invalidateQueries({ queryKey: getListArchiveCharactersQueryKey() }),
    qc.invalidateQueries({ queryKey: getListPublicCharactersQueryKey() }),
    qc.invalidateQueries({ queryKey: getListPublicCharacterTagsQueryKey() }),
  ];
  if (characterId != null) {
    jobs.push(
      qc.invalidateQueries({ queryKey: getGetCharacterQueryKey(characterId) }),
      qc.invalidateQueries({ queryKey: getGetCharacterInventoryQueryKey(characterId) }),
      qc.invalidateQueries({ queryKey: getGetArchiveCharacterQueryKey(characterId) }),
      qc.invalidateQueries({ queryKey: getGetPublicCharacterQueryKey(characterId) }),
    );
  }
  return Promise.all(jobs);
}
