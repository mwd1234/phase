type DataHandler = (data: unknown) => void | Promise<void>;
type CloseHandler = () => void;
type ErrorHandler = (error: Error) => void;

/** Raw-byte PeerJS fake shared by draft session and adapter regressions. */
export class FakeDraftDataConnection {
  open = true;
  readonly sentRaw: Uint8Array[] = [];
  private readonly dataHandlers = new Set<DataHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();

  send(bytes: Uint8Array): void {
    if (!this.open) throw new Error("Connection is closed");
    this.sentRaw.push(bytes);
  }

  on(event: "data", handler: DataHandler): this;
  on(event: "close", handler: CloseHandler): this;
  on(event: "error", handler: ErrorHandler): this;
  on(event: string, handler: DataHandler | CloseHandler | ErrorHandler): this {
    if (event === "data") this.dataHandlers.add(handler as DataHandler);
    else if (event === "close") this.closeHandlers.add(handler as CloseHandler);
    else if (event === "error") this.errorHandlers.add(handler as ErrorHandler);
    return this;
  }

  /** Preserve the input representation and await the production receive chain. */
  async receiveRaw(raw: unknown): Promise<void> {
    await Promise.all([...this.dataHandlers].map((handler) => handler(raw)));
  }

  close(): void {
    this.simulateClose();
  }

  simulateClose(): void {
    if (!this.open) return;
    this.open = false;
    for (const handler of this.closeHandlers) handler();
  }

  simulateError(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }
}
