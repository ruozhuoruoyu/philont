/**
 * Credential management (zero-exposure injection model)
 *
 * Core idea: tool code uses placeholders; the host injects the real values
 * before sending HTTP requests.  Works together with SecretStore
 * (AES-256-GCM encrypted storage) for at-rest encryption + dynamic injection.
 */

export { SecretStore } from './store.js';
export type { SecretStoreOptions } from './store.js';

export { createInjectingFetch } from './injector.js';
export type { InjectingFetchOptions } from './injector.js';
