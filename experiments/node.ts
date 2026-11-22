// Imported first by the runner and the match worker, before any browser module. Node 25 and
// later have a Web Storage of their own (experimental: reading `localStorage` without
// --localstorage-file prints a warning). The browser code reads storage guarded, as in a browser
// that blocks it (src/ai/AiServer.ts, src/state/MapStore.ts): here there is none, so nothing of a
// run is read from or kept in it.
for (const name of ['localStorage', 'sessionStorage'])
  Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true });

export {};
