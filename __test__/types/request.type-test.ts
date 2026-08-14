import {
  HandlerResponseError,
  MalformedResponseError,
  ProsodyClient,
  ResponseError,
  ResponseFormatMismatchError,
  ResponseTimeoutError,
  type ErrorCategory,
  type RequestResult,
} from "../../index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
declare function assertTrue<T extends true>(): void;

declare const client: ProsodyClient;

async function request(): Promise<void> {
  const results = await client.request<{ total: number }>(
    "orders",
    "order-1",
    { type: "order.created" },
    ["billing"],
    2_000,
    { headers: { tenant: "acme" } },
  );
  assertTrue<
    Equal<(typeof results)[number], RequestResult<{ total: number }>>
  >();

  const result = results[0];
  if (result instanceof HandlerResponseError) {
    assertTrue<Equal<typeof result.category, ErrorCategory>>();
    assertTrue<Equal<typeof result.handlerMessage, string>>();
  } else if (result instanceof ResponseTimeoutError) {
    assertTrue<Equal<typeof result, ResponseTimeoutError>>();
  } else if (result instanceof ResponseFormatMismatchError) {
    assertTrue<Equal<typeof result, ResponseFormatMismatchError>>();
  } else if (result instanceof MalformedResponseError) {
    assertTrue<Equal<typeof result, MalformedResponseError>>();
  } else if (!(result instanceof ResponseError) && result !== undefined) {
    assertTrue<Equal<typeof result, { total: number }>>();
  }
}

void request;
