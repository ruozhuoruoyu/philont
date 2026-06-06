/**
 * PermissionMatrix: 3×4 capability × domain permission matrix
 *
 *          local   network   system   self
 * read       ✓        ✓        ✗       ✓
 * write      ✓        ✗        ✗       ✓  (Internal: direct; External: requires OnApproval)
 * execute    ✗        ✗        ✗       ✗
 *
 * The `self` domain is dedicated to agent self-state management (memory/calendar/skill/schedule etc.),
 * with no side effects on the shared filesystem or external services.
 * Only the kernel-trusted toolset may declare domain='self'; third-party plugins are not allowed
 * (enforced by ToolRegistry at registration time).
 */

export type Capability = 'read' | 'write' | 'execute';
export type Domain     = 'local' | 'network' | 'system' | 'self';

/** Signal origin: marks whether the current tool call is LLM-initiated or framework-internal */
export type SignalOrigin = 'Internal' | 'External';

export interface PermissionMatrix {
  read:    Record<Domain, boolean>;
  write:   Record<Domain, boolean>;
  execute: Record<Domain, boolean>;
}

/** Default matrix: read-only local+network+self, write local+self, execute forbidden */
export function createDefaultMatrix(): PermissionMatrix {
  return {
    read:    { local: true,  network: true,  system: false, self: true  },
    write:   { local: true,  network: false, system: false, self: true  },
    execute: { local: false, network: false, system: false, self: false },
  };
}

/**
 * Read-only matrix: disallows **external** writes (local/network/system) but permits **self** writes.
 *
 * Design rationale: "readonly" means "no mutations with side effects that spill outside the agent".
 * Self-domain operations such as memory/calendar/skill are agent self-state; their effects
 * do not leave the agent boundary and should therefore be exempt.
 * Otherwise, when the server runs with the readonly matrix, even introspective operations
 * like "remember the user's name" would be blocked.
 */
export function createReadOnlyMatrix(): PermissionMatrix {
  return {
    read:    { local: true,  network: true,  system: false, self: true  },
    write:   { local: false, network: false, system: false, self: true  },
    execute: { local: false, network: false, system: false, self: false },
  };
}

/** Sandbox matrix: completely forbids all operations (for testing/isolation) */
export function createSandboxMatrix(): PermissionMatrix {
  return {
    read:    { local: false, network: false, system: false, self: false },
    write:   { local: false, network: false, system: false, self: false },
    execute: { local: false, network: false, system: false, self: false },
  };
}

/** Check whether a given capability + domain combination is allowed */
export function checkPermission(
  matrix: PermissionMatrix,
  capability: Capability,
  domain: Domain,
): boolean {
  return matrix[capability][domain];
}

/**
 * Tool classification result: maps a tool name to capability + domain.
 * Provided by the application layer; the policy layer contains no built-in business knowledge.
 */
export interface ToolClassification {
  capability: Capability;
  domain:     Domain;
}

/**
 * Check whether a tool call satisfies the permission matrix
 * @returns null if the tool is unknown (allowed by default), otherwise returns whether it is permitted
 */
export function checkToolPermission(
  matrix: PermissionMatrix,
  toolName: string,
  classify: (name: string) => ToolClassification | null,
): boolean | null {
  const cls = classify(toolName);
  if (cls === null) return null;
  return checkPermission(matrix, cls.capability, cls.domain);
}
