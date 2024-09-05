import type {
  Configuration,
  ConsumerState,
  Context,
  Logger,
  Message,
  Mode,
} from "./bindings";

export { Configuration, ConsumerState, Context, Logger, Message, Mode };

export interface EventHandler {
  /**
   * Callback function to handle incoming messages.
   *
   * @param context - The context of the message processing.
   * @param message - The received Kafka message.
   * @param signal - An AbortSignal that can be used to cancel the message processing.
   * @returns A promise that resolves when the message has been processed.
   */
  onMessage: (
    context: Context,
    message: Message,
    signal: AbortSignal,
  ) => Promise<void>;
}

export declare class ProsodyClient {
  /**
   * Creates a new ProsodyClient instance.
   *
   * @param config - The configuration options for the client.
   */
  constructor(config: Configuration);

  /**
   * Gets the current state of the consumer.
   *
   * @returns The current state of the consumer.
   */
  get consumerState(): ConsumerState;

  /**
   * Sends a message to a specified Kafka topic.
   *
   * @param topic - The name of the topic to send the message to.
   * @param key - The key of the message.
   * @param payload - The message payload.
   * @param signal - An optional AbortSignal that can be used to cancel the send operation.
   * @returns A promise that resolves when the message has been sent.
   */
  send(
    topic: string,
    key: string,
    payload: any,
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * Subscribes to receive messages using the provided event handler.
   *
   * @param eventHandler - The event handler to process received messages.
   */
  subscribe(eventHandler: EventHandler): void;

  /**
   * Unsubscribes from receiving messages and shuts down the consumer.
   *
   * @returns A promise that resolves when the unsubscribe operation is complete.
   */
  unsubscribe(): Promise<void>;
}

/**
 * Sets a new JavaScript logger.
 *
 * @param logger - The new JavaScript logger to set.
 */
export function setLogger(logger: Logger): void;
