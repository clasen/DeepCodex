// Optional Jev-style compaction for the orchestrator route.
//
// The installed Codex client asks for compaction on the normal Responses endpoint: the
// request carries `"request_kind":"compaction"` in x-codex-turn-metadata and appends its
// checkpoint instruction to the history. When the option is enabled the router answers
// that request itself instead of relaying it: it prunes tool exchanges, stores the pruned
// history in a private local file and returns a short local reference where the client
// expects a summary. A later request carrying that reference is expanded from the store,
// so the provider never sees the reference and never produces a native summary.
// The option is disabled by default; see config/pilot.json (jev_compaction).

import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePrivateDirectory, privateRead, privateWrite } from './private-files.js';

const REFERENCE_PREFIX = 'deepcodex-jev-v1:';
const REFERENCE = /deepcodex-jev-v1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORE_VERSION = 1;
// The client's checkpoint instruction is scaffolding, not conversation, so it is left out
// of the stored history. A customized compact_prompt keeps the instruction in the store.
const COMPACTION_INSTRUCTION = 'CONTEXT CHECKPOINT COMPACTION';
const SUMMARY_PREAMBLE = 'Another language model started to solve this problem and produced a summary of its thinking process.';

export function compactionDirectory(config) {
  return path.join(os.tmpdir(), config.jev_compaction.store);
}

export function compactionRequest(metadata) {
  if (typeof metadata !== 'string') return false;
  try {
    return JSON.parse(metadata)?.request_kind === 'compaction';
  } catch {
    return false;
  }
}

// A tool exchange is a call item and the result that answers it. Everything else, including
// a call whose result never arrived, is preserved verbatim.
export function isToolCall(item) {
  return typeof item?.type === 'string' && item.type.endsWith('_call') && typeof item.call_id === 'string';
}

export function isToolResult(item) {
  if (typeof item?.type !== 'string' || typeof item.call_id !== 'string') return false;
  return item.type.endsWith('_call_output') || item.type === 'tool_search_output';
}

export function toolExchanges(items) {
  const results = new Map();
  items.forEach((item, index) => {
    if (isToolResult(item)) results.set(item.call_id, index);
  });
  const exchanges = [];
  items.forEach((item, index) => {
    if (!isToolCall(item)) return;
    if (!results.has(item.call_id)) return;
    exchanges.push({ callId: item.call_id, callIndex: index, resultIndex: results.get(item.call_id) });
  });
  return exchanges;
}

// Placeholder for Jev while the prototype runs without credentials: the recent window
// survives and every older tool exchange is dropped. A real integration supplies an asker
// that returns Jev's scored decisions for the same candidates.
export function retainRecentOnly({ exchanges }) {
  return exchanges.map(() => ({ keepCall: false, keepResult: false }));
}

function decisionOf(decisions, index) {
  const decision = decisions[index];
  if (decision === null || typeof decision !== 'object') {
    throw new Error(`Compaction decision ${index} must be an object`);
  }
  if (typeof decision.keepCall !== 'boolean' || typeof decision.keepResult !== 'boolean') {
    throw new Error(`Compaction decision ${index} must carry boolean keepCall and keepResult`);
  }
  return decision;
}

// An exchange survives only when both halves are kept: half a pair would leave the provider
// a call without its result or a result without its call.
export async function selectHistory(items, { asker, retainRecent }) {
  if (!Number.isInteger(retainRecent) || retainRecent < 0) {
    throw new Error('jev_compaction.retain_recent must be a non-negative integer');
  }
  const candidates = toolExchanges(items).filter(exchange => exchange.callIndex < items.length - retainRecent);
  if (candidates.length === 0) return items;
  const decisions = await asker({ items, exchanges: candidates });
  if (!Array.isArray(decisions) || decisions.length !== candidates.length) {
    throw new Error(`Compaction asker returned ${Array.isArray(decisions) ? decisions.length : 'no'} decisions for ${candidates.length} candidate exchanges`);
  }
  const dropped = new Set();
  for (let index = 0; index < candidates.length; index += 1) {
    const decision = decisionOf(decisions, index);
    if (decision.keepCall && decision.keepResult) continue;
    dropped.add(candidates[index].callIndex);
    dropped.add(candidates[index].resultIndex);
  }
  return items.filter((item, index) => !dropped.has(index));
}

export function stripCompactionInstruction(items) {
  const last = items.at(-1);
  if (last?.type !== 'message' || last.role !== 'user') return items;
  const text = (last.content ?? []).map(part => part?.text ?? '').join('\n');
  return text.includes(COMPACTION_INSTRUCTION) ? items.slice(0, -1) : items;
}

export function estimateTokens(items) {
  return Math.ceil(JSON.stringify(items).length / 4);
}

export function referenceText(id) {
  return REFERENCE_PREFIX + id;
}

function itemReference(item) {
  if (item?.type !== 'message' || item.role !== 'user' || !Array.isArray(item.content)) return null;
  for (const part of item.content) {
    if (typeof part?.text !== 'string' || !part.text.startsWith(`${SUMMARY_PREAMBLE}\n`)) continue;
    const at = part.text.indexOf(REFERENCE_PREFIX);
    if (at === -1) continue;
    const found = REFERENCE.exec(part.text.slice(at));
    return found ? { id: found[1] } : { invalid: true };
  }
  return null;
}

export function createStore(directory) {
  return {
    save(items) {
      const id = randomUUID();
      ensurePrivateDirectory(directory);
      privateWrite(path.join(directory, `${id}.json`), JSON.stringify({ version: STORE_VERSION, items }));
      return id;
    },
    load(id) {
      if (!UUID.test(id)) throw new Error('Invalid local compaction reference');
      const text = privateRead(path.join(directory, `${id}.json`));
      if (text === null) throw new Error('Unknown local compaction reference');
      let stored;
      try {
        stored = JSON.parse(text);
      } catch {
        throw new Error('Unreadable local compaction reference');
      }
      if (stored?.version !== STORE_VERSION || !Array.isArray(stored.items)) {
        throw new Error('Unreadable local compaction reference');
      }
      return stored.items;
    },
  };
}

// The summary message stands in for the whole history before it, so the retained prefix the
// client keeps next to it is dropped here: the stored history already covers it, exactly once.
export function expandReferences(items, store) {
  let at = -1;
  let id = null;
  for (let index = 0; index < items.length; index += 1) {
    const found = itemReference(items[index]);
    if (!found) continue;
    if (found.invalid) throw new Error('Invalid local compaction reference');
    at = index;
    id = found.id;
  }
  if (at === -1) return items;
  if (!store) throw new Error('Invalid local compaction reference');
  return [...store.load(id), ...items.slice(at + 1)];
}
