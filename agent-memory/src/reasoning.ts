/**
 * ReasoningStore — persisted state for the deep reasoning subsystem (schema v25).
 *
 * This is the core of philont's deep reasoning: persist the intermediate state of reasoning
 * (subgoal trees / proved lemmas / dead ends) into DB, accumulating across turns and days.
 * Other AutoResearch implementations keep reasoning state within a single call; this one persists.
 *
 *   reasoning_sessions  a reasoning session for a hard problem/conjecture (root proposition + status + cross-turn budget accumulation)
 *   reasoning_nodes     subgoal tree nodes (parent_id forms tree; status includes dead_end;
 *                       approaches_tried is backtracking memory — remembers tried dead ends to avoid repeating them)
 *
 * Pure CRUD, does not call LLM or touch tool permissions. Orchestration (mini-loop / rendering / convergence)
 * is done on the server side in deep_explore.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type ReasoningSessionStatus = 'active' | 'solved' | 'stuck' | 'abandoned';
export type ReasoningNodeKind = 'subgoal' | 'lemma' | 'construction' | 'counterexample' | 'conjecture';
export type ReasoningNodeStatus = 'open' | 'proved' | 'refuted' | 'dead_end' | 'blocked';

export interface ReasoningSession {
  id: string;
  goal: string;
  assumptions: string[];
  status: ReasoningSessionStatus;
  /** Chat session (wechat:… / web-ui id / system:scheduled:…) that started this reasoning; null for pre-v28 sessions. Scopes continue/status so concurrent channels don't hijack each other. */
  ownerSessionId: string | null;
  rootNodeId: string | null;
  /** Cumulative LLM token cost across turns (single-turn loop gate is PlanBudgetTracker; this is the running total) */
  budgetSpent: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReasoningNode {
  id: string;
  sessionId: string;
  parentId: string | null;
  claim: string;
  kind: ReasoningNodeKind;
  status: ReasoningNodeStatus;
  result: string | null;
  /** Backtracking memory: which approaches were tried for this node (appended on dead_end), to avoid repeating them */
  approachesTried: string[];
  evidenceRefs: string[];
  depth: number;
  /** value-guided node selection: latest estimate from an independent aux-LLM of "value/attackability towards the root proposition" (0-1, null=not yet evaluated) */
  value: number | null;
  /** Number of turns this node has been advanced as an active frontier (denominator for UCB exploration term) */
  visits: number;
  /** Proof/exploration technique tag (behavior descriptor for MAP-Elites bucketing + novelty; null=unclassified) */
  technique: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SessionRow {
  id: string;
  goal: string;
  assumptions_json: string | null;
  status: string;
  owner_session_id: string | null;
  root_node_id: string | null;
  budget_spent: number;
  created_at: number;
  updated_at: number;
}

interface NodeRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  claim: string;
  kind: string;
  status: string;
  result: string | null;
  approaches_tried_json: string | null;
  evidence_refs_json: string | null;
  depth: number;
  value: number | null;
  visits: number;
  technique: string | null;
  created_at: number;
  updated_at: number;
}

function rowToSession(r: SessionRow): ReasoningSession {
  return {
    id: r.id,
    goal: r.goal,
    assumptions: r.assumptions_json ? (JSON.parse(r.assumptions_json) as string[]) : [],
    status: r.status as ReasoningSessionStatus,
    ownerSessionId: r.owner_session_id ?? null,
    rootNodeId: r.root_node_id,
    budgetSpent: r.budget_spent,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToNode(r: NodeRow): ReasoningNode {
  return {
    id: r.id,
    sessionId: r.session_id,
    parentId: r.parent_id,
    claim: r.claim,
    kind: r.kind as ReasoningNodeKind,
    status: r.status as ReasoningNodeStatus,
    result: r.result,
    approachesTried: r.approaches_tried_json
      ? (JSON.parse(r.approaches_tried_json) as string[])
      : [],
    evidenceRefs: r.evidence_refs_json ? (JSON.parse(r.evidence_refs_json) as string[]) : [],
    depth: r.depth,
    value: r.value ?? null,
    visits: r.visits ?? 0,
    technique: r.technique ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Thrown when the parent node does not exist (or does not belong to this session) — lets the deep_explore tool return an error text for the sub-LLM to self-correct. */
export class ReasoningNodeNotFoundError extends Error {
  constructor(public readonly nodeId: string) {
    super(`reasoning node not found: ${nodeId}`);
    this.name = 'ReasoningNodeNotFoundError';
  }
}

export class ReasoningStore {
  constructor(private readonly db: Database.Database) {}

  /** Create a session + root node (claim=goal). Returns both. */
  createSession(input: { goal: string; assumptions?: string[]; ownerSessionId?: string | null }): {
    session: ReasoningSession;
    rootNode: ReasoningNode;
  } {
    const now = Date.now();
    const sessionId = randomUUID();
    const rootId = randomUUID();

    this.db
      .prepare<[string, string, string, string | null, string, number, number]>(
        `INSERT INTO reasoning_sessions
          (id, goal, assumptions_json, status, owner_session_id, root_node_id, budget_spent, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, 0, ?, ?)`,
      )
      .run(
        sessionId,
        input.goal,
        JSON.stringify(input.assumptions ?? []),
        input.ownerSessionId ?? null,
        rootId,
        now,
        now,
      );

    this.db
      .prepare<[string, string, string, number, number]>(
        `INSERT INTO reasoning_nodes
          (id, session_id, parent_id, claim, kind, status, result,
           approaches_tried_json, evidence_refs_json, depth, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'subgoal', 'open', NULL, '[]', '[]', 0, ?, ?)`,
      )
      .run(rootId, sessionId, input.goal, now, now);

    return {
      session: this.getSession(sessionId)!,
      rootNode: this.getNode(sessionId, rootId)!,
    };
  }

  getSession(id: string): ReasoningSession | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM reasoning_sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /** Active sessions, most recently updated first. */
  /**
   * Active sessions, most recently updated first. When `ownerSessionId` is provided, only sessions
   * started by that chat session are returned — this is what keeps two concurrent channels from
   * seeing each other's reasoning. Passing `undefined`/`null` returns ALL active sessions (legacy).
   */
  listActiveSessions(ownerSessionId?: string | null): ReasoningSession[] {
    const rows = (
      ownerSessionId == null
        ? this.db
            .prepare(`SELECT * FROM reasoning_sessions WHERE status = 'active' ORDER BY updated_at DESC`)
            .all()
        : this.db
            .prepare(
              // Owner-scoped, BUT legacy NULL-owner sessions (created before v28, when no owner was
              // recorded) stay resumable by any channel — a graceful migration so an in-flight
              // pre-upgrade reasoning session isn't orphaned. They age out as they close; every NEW
              // session has a non-NULL owner and is therefore strictly isolated.
              `SELECT * FROM reasoning_sessions
               WHERE status = 'active' AND (owner_session_id = ? OR owner_session_id IS NULL)
               ORDER BY updated_at DESC`,
            )
            .all(ownerSessionId)
    ) as SessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * Most recent active session for `ownerSessionId` (default target for continue; avoids LLM
   * hallucinating sessionId). Scoped to the owner so a continue on one channel never grabs another
   * channel's reasoning. Omitting `ownerSessionId` falls back to the global most-recent (legacy).
   */
  getMostRecentActiveSession(ownerSessionId?: string | null): ReasoningSession | null {
    return this.listActiveSessions(ownerSessionId)[0] ?? null;
  }

  /**
   * Compact ground-truth snapshot of a session: status + open-frontier / proved / dead counts.
   * "Open frontier" = open leaf nodes (no children). Used by the honesty gate to check a
   * "reasoning concluded" claim against reality, and reusable for progress rendering.
   */
  summarizeSession(
    sessionId: string,
  ): { status: ReasoningSessionStatus; openFrontierCount: number; provedCount: number; deadCount: number } | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const nodes = this.getNodes(sessionId);
    const hasChild = new Set<string>();
    for (const n of nodes) if (n.parentId) hasChild.add(n.parentId);
    const openFrontierCount = nodes.filter((n) => n.status === 'open' && !hasChild.has(n.id)).length;
    const provedCount = nodes.filter((n) => n.status === 'proved').length;
    const deadCount = nodes.filter((n) => n.status === 'dead_end').length;
    return { status: session.status, openFrontierCount, provedCount, deadCount };
  }

  getNode(sessionId: string, nodeId: string): ReasoningNode | null {
    const row = this.db
      .prepare<[string, string]>(
        `SELECT * FROM reasoning_nodes WHERE id = ? AND session_id = ?`,
      )
      .get(nodeId, sessionId) as NodeRow | undefined;
    return row ? rowToNode(row) : null;
  }

  /** All nodes in a session (sorted by depth, created_at for tree rendering). */
  getNodes(sessionId: string): ReasoningNode[] {
    const rows = this.db
      .prepare<[string]>(
        `SELECT * FROM reasoning_nodes WHERE session_id = ? ORDER BY depth, created_at`,
      )
      .all(sessionId) as NodeRow[];
    return rows.map(rowToNode);
  }

  getTree(sessionId: string): { session: ReasoningSession; nodes: ReasoningNode[] } | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    return { session, nodes: this.getNodes(sessionId) };
  }

  /**
   * Add child nodes under parentId (decompose). Validates that parent exists in this session;
   * throws ReasoningNodeNotFoundError if not found (so the tool can return an error text).
   * Returns **newly created nodes (with ids)**.
   */
  addNodes(
    sessionId: string,
    parentId: string,
    children: Array<{ claim: string; kind: ReasoningNodeKind }>,
  ): ReasoningNode[] {
    const parent = this.getNode(sessionId, parentId);
    if (!parent) throw new ReasoningNodeNotFoundError(parentId);

    const now = Date.now();
    const created: ReasoningNode[] = [];
    const insert = this.db.prepare<
      [string, string, string, string, string, number, number, number]
    >(
      `INSERT INTO reasoning_nodes
        (id, session_id, parent_id, claim, kind, status, result,
         approaches_tried_json, evidence_refs_json, depth, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', NULL, '[]', '[]', ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const c of children) {
        const id = randomUUID();
        insert.run(id, sessionId, parentId, c.claim, c.kind, parent.depth + 1, now, now);
        created.push(this.getNode(sessionId, id)!);
      }
    });
    tx();
    this.touchSession(sessionId, now);
    return created;
  }

  /**
   * Update node status/result (record). WHERE id AND session_id; returns null if not found (so the tool can return an error text).
   *   - appendApproach: when dead_end, append the tried approach to approaches_tried (backtracking memory)
   *   - addEvidence: append an evidence ref
   */
  updateNode(
    sessionId: string,
    nodeId: string,
    patch: {
      status?: ReasoningNodeStatus;
      result?: string | null;
      appendApproach?: string;
      addEvidence?: string;
    },
  ): ReasoningNode | null {
    const node = this.getNode(sessionId, nodeId);
    if (!node) return null;

    const status = patch.status ?? node.status;
    const result = patch.result !== undefined ? patch.result : node.result;
    const approaches = patch.appendApproach
      ? [...node.approachesTried, patch.appendApproach]
      : node.approachesTried;
    const evidence = patch.addEvidence
      ? [...node.evidenceRefs, patch.addEvidence]
      : node.evidenceRefs;
    const now = Date.now();

    this.db
      .prepare<[string, string | null, string, string, number, string, string]>(
        `UPDATE reasoning_nodes
           SET status = ?, result = ?, approaches_tried_json = ?, evidence_refs_json = ?, updated_at = ?
         WHERE id = ? AND session_id = ?`,
      )
      .run(status, result, JSON.stringify(approaches), JSON.stringify(evidence), now, nodeId, sessionId);
    this.touchSession(sessionId, now);
    return this.getNode(sessionId, nodeId);
  }

  setSessionStatus(id: string, status: ReasoningSessionStatus): void {
    this.db
      .prepare<[string, number, string]>(
        `UPDATE reasoning_sessions SET status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, Date.now(), id);
  }

  /** Accumulate cross-turn budget cost. */
  addBudgetSpent(id: string, tokens: number): void {
    this.db
      .prepare<[number, number, string]>(
        `UPDATE reasoning_sessions SET budget_spent = budget_spent + ?, updated_at = ? WHERE id = ?`,
      )
      .run(Math.max(0, Math.floor(tokens)), Date.now(), id);
  }

  /**
   * Batch-write node values (value-guided node selection; clamped to [0,1]). Optionally includes technique (MAP-Elites bucketing).
   * technique omitted (undefined) → only updates value, retains original technique; provided (including null) → also writes technique. Only touches this session.
   */
  setNodeValues(
    sessionId: string,
    values: Array<{ id: string; value: number; technique?: string | null }>,
  ): void {
    if (values.length === 0) return;
    const valueOnly = this.db.prepare<[number, string, string]>(
      `UPDATE reasoning_nodes SET value = ? WHERE id = ? AND session_id = ?`,
    );
    const valueAndTech = this.db.prepare<[number, string | null, string, string]>(
      `UPDATE reasoning_nodes SET value = ?, technique = ? WHERE id = ? AND session_id = ?`,
    );
    const tx = this.db.transaction(() => {
      for (const { id, value, technique } of values) {
        const v = Math.max(0, Math.min(1, value));
        if (technique === undefined) valueOnly.run(v, id, sessionId);
        else valueAndTech.run(v, technique, id, sessionId);
      }
    });
    tx();
  }

  /** Increment visits by 1 for a batch of nodes (UCB exploration term: records "these frontier nodes were advanced another round"). */
  incrementVisits(sessionId: string, nodeIds: string[]): void {
    if (nodeIds.length === 0) return;
    const stmt = this.db.prepare<[string, string]>(
      `UPDATE reasoning_nodes SET visits = visits + 1 WHERE id = ? AND session_id = ?`,
    );
    const tx = this.db.transaction(() => {
      for (const id of nodeIds) stmt.run(id, sessionId);
    });
    tx();
  }

  private touchSession(id: string, now: number): void {
    this.db
      .prepare<[number, string]>(`UPDATE reasoning_sessions SET updated_at = ? WHERE id = ?`)
      .run(now, id);
  }
}
