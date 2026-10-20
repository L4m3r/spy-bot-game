// All RPC results in this bot are plain structured data. Return a local copy
// and release both the result and the pipeline, including when the RPC throws.
// Current Workers types omit the pipeline's runtime Symbol.dispose method.
export async function rpcData<T>(call: Promise<T>): Promise<T> {
  try {
    const result = await call;
    try { return structuredClone(result); }
    finally { (result as T & Partial<Disposable>)?.[Symbol.dispose]?.(); }
  } finally {
    (call as Promise<T> & Partial<Disposable>)[Symbol.dispose]?.();
  }
}
