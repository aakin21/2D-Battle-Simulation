// The part of the Workers runtime's `cloudflare:workers` module this Worker uses (Wrangler
// provides the module when it builds; @cloudflare/workers-types is not needed for this much).
declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: import('./quota').DurableObjectStateLike;
    protected env: Env;
    constructor(ctx: import('./quota').DurableObjectStateLike, env: Env);
  }
}
