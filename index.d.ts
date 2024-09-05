import {
  Configuration,
  ConsumerState,
  Context,
  Logger,
  Message,
  Mode,
} from "./bindings";

export interface EventHandler {
  onMessage: (
    context: Context,
    message: Message,
    signal: AbortSignal,
  ) => Promise<void>;
}

declare class ProsodyClient {
  constructor(config: Configuration);

  get consumerState(): ConsumerState;

  send(
    topic: string,
    key: string,
    payload: any,
    signal?: AbortSignal,
  ): Promise<void>;

  subscribe(eventHandler: EventHandler): void;

  unsubscribe(): Promise<void>;
}

export {
  Configuration,
  ConsumerState,
  Context,
  Logger,
  Message,
  Mode,
  ProsodyClient,
};
