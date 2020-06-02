export class BaseRequestSettings {
    public traceId?: string;
    public timeout?: number;
    public cancelAfter?: number;
    public operationTimeout?: number;

    /**
     * Includes trace id for RPC headers
     *
     * @param traceId - A trace id string
     * @return The self instance
     */
    public withTraceId(traceId: string) {
        this.traceId = traceId;
        return this;
    }

    /**
     * Indicates that client is no longer interested in the result of operation after the specified duration
     * starting from the time operation arrives at the server.
     * Server will try to stop the execution of operation and if no result is currently available the operation
     * will receive TIMEOUT status code, which will be sent back to client if it was waiting for the operation result.
     * Timeout of operation does not tell anything about its result, it might be completed successfully
     * or cancelled on server.
     *
     * @param timeout
     * @return The self instance
     */
    public withOperationTimeout(timeout: number) {
        this.operationTimeout = timeout;
        return this;
    }

    /**
     * Server will try to cancel the operation after the specified duration starting from the time
     * the operation arrives at server.
     * In case of successful cancellation operation will receive CANCELLED status code, which will be
     * sent back to client if it was waiting for the operation result.
     * In case when cancellation isn't possible, no action will be performed.
     *
     * @param timeout
     * @return The self instance
     */
    public withCancelAfter(timeout: number) {
        this.cancelAfter = timeout;
        return this;
    }

    /**
     * Client-side timeout to complete request.
     * Since YDB doesn't support request cancellation at this moment, this feature should be
     * used properly to avoid server overload.
     *
     * @param timeout
     * @return The self instance
     */
    public withTimeout(timeout: number) {
        this.timeout = timeout;
        return this;
    }
}
