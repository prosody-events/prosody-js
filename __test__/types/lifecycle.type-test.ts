/**
 * Compile-time contract for the client lifecycle. Run by
 * `npm run typecheck`; never executed.
 */
import { ProsodyClient } from "../../index";

export async function scoped(): Promise<void> {
  await using client = await ProsodyClient.create({ mock: true });
  const disposable: AsyncDisposable = client;
  void disposable;
}
