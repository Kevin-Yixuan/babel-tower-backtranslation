// Keep read/merge/write operations on content records in one short-lived queue.
// Model requests never enter this queue.
let pending = Promise.resolve();
export function withContentStorage(operation) {
  const result = pending.then(operation);
  pending = result.catch(() => {});
  return result;
}
