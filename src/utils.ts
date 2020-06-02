import grpc, {Metadata} from 'grpc';
import * as $protobuf from 'protobufjs';
import _ from 'lodash';

import {google, Ydb} from '../proto/bundle';
import {YdbError, StatusCode, NotFound, MissingValue, MissingOperation, DeadlineExceed} from './errors';
import {Endpoint} from './discovery';
import {IAuthService} from './credentials';
import {BaseRequestSettings} from './request-settings';


export interface Pessimizable {
    endpoint: Endpoint;
}

type ServiceFactory<T> = {
    create(rpcImpl: $protobuf.RPCImpl, requestDelimited?: boolean, responseDelimited?: boolean): T
};

export interface ISslCredentials {
    rootCertificates?: Buffer,
    clientPrivateKey?: Buffer,
    clientCertChain?: Buffer
}

function removeProtocol(entryPoint: string) {
    const re = /^(grpc:\/\/|grpcs:\/\/)?(.+)/;
    const match = re.exec(entryPoint) as string[];
    return match[2];
}

export abstract class GrpcService<Api extends $protobuf.rpc.Service> {
    protected api: Api;

    protected constructor(
        host: string,
        private name: string,
        private apiCtor: ServiceFactory<Api>,
        sslCredentials?: ISslCredentials
    ) {
        this.api = this.getClient(removeProtocol(host), sslCredentials);
    }

    protected getClient(host: string, sslCredentials?: ISslCredentials): Api {
        const client = sslCredentials ?
            new grpc.Client(host, grpc.credentials.createSsl()) :
            new grpc.Client(host, grpc.credentials.createInsecure());
        const rpcImpl: $protobuf.RPCImpl = (method, requestData, callback) => {
            const path = `/${this.name}/${method.name}`;
            client.makeUnaryRequest(path, _.identity, _.identity, requestData, null, null, callback);
        };
        return this.apiCtor.create(rpcImpl);
    }
}

const DEFAULT_TIMEOUT = 600; // 10 minutes
const NANOS_IN_SECOND = 10**9;
const YDB_TRACE_ID_HEADER = 'x-ydb-trace-id';

function getDuration(seconds: number) {
    return google.protobuf.Duration.create({
        seconds: Math.floor(seconds),
        nanos: Math.floor((seconds - Math.floor(seconds)) * NANOS_IN_SECOND)
    });
}

async function withTimeoutRequest(request: any, timeout: number) {
    if (timeout === 0) {
        return request;
    }
    return new Promise(async (resolve, reject) => {
        const timerId = setTimeout(
            () => reject(new DeadlineExceed('Deadline exceeded on request')),
            timeout * 1000
        );
        const result = await request;
        clearTimeout(timerId);
        resolve(result);
    });
}

export type ApiService<T> = {
    (settings?: BaseRequestSettings): ApiService<T>
} & T;

export abstract class BaseService<Api extends $protobuf.rpc.Service> {
    protected api: ApiService<Api>;
    private service: Api;
    private metadata: Metadata | null = null;
    private settings?: BaseRequestSettings;

    /**
     * All methods that make queries have 2 parameters (request and callback).
     *
     * @param property
     */
    static isServiceAsyncMethod(property: unknown) {
        return (
            typeof property === 'function' &&
            property.length === 2
        );
    }

    protected constructor(
        host: string,
        private name: string,
        private apiCtor: ServiceFactory<Api>,
        private authService: IAuthService
    ) {
        this.service = this.getClient(removeProtocol(host), this.authService.sslCredentials);
        this.api = new Proxy(
            Object.assign(function(){}),
            {
                get: (_target, prop) => {
                    const property = Reflect.get(this.service, prop);
                    return BaseService.isServiceAsyncMethod(property) ?
                        async (request: {operationParams?: Ydb.Operations.IOperationParams}, callback: any) => {
                            const settings = this.settings;
                            this.settings = undefined;

                            const timeout = settings?.timeout ?? DEFAULT_TIMEOUT;
                            const operationTimeout = settings?.operationTimeout ?? timeout;
                            const cancelAfter = settings?.cancelAfter ?? timeout;

                            request.operationParams = Ydb.Operations.OperationParams.create({
                                operationTimeout: getDuration(operationTimeout),
                                cancelAfter: getDuration(cancelAfter)
                            });

                            this.metadata = await this.authService.getAuthMetadata();
                            if (settings?.traceId !== undefined) {
                                this.metadata.add(YDB_TRACE_ID_HEADER, settings.traceId);
                            }

                            if (!callback) {
                                return withTimeoutRequest(property.call(this.service, request), timeout);
                            }
                            const timerId = setTimeout(() => {
                                callback(new DeadlineExceed('Deadline exceeded on request'), timeout * 1000);
                            })
                            property.call(this.service, request, (err: any, res: any) => {
                                clearTimeout(timerId);
                                if (err) {
                                    callback(err);
                                } else {
                                    callback(null, res);
                                }
                            });
                        } :
                        property;
                },
                apply: (_target, _thisArg, [settings]: [BaseRequestSettings]) => {
                    this.settings = settings;
                    return this.api;
                }
            }
        ) as unknown as ApiService<Api>;
    }

    protected getClient(host: string, sslCredentials?: ISslCredentials): Api {
        const client = sslCredentials ?
            new grpc.Client(host, grpc.credentials.createSsl(sslCredentials.rootCertificates)) :
            new grpc.Client(host, grpc.credentials.createInsecure());
        const rpcImpl: $protobuf.RPCImpl = (method, requestData, callback) => {
            const path = `/${this.name}/${method.name}`;
            client.makeUnaryRequest(path, _.identity, _.identity, requestData, this.metadata, null, callback);
        };
        return this.apiCtor.create(rpcImpl);
    }
}

interface AsyncResponse {
    operation?: Ydb.Operations.IOperation | null
}

export function getOperationPayload(response: AsyncResponse): Uint8Array {
    const {operation} = response;

    if (operation) {
        YdbError.checkStatus(operation);
        const value = operation?.result?.value;
        if (!value) {
            throw new MissingValue('Missing operation result value!');
        }
        return value;
    } else {
        throw new MissingOperation('No operation in response!');
    }
}

export function ensureOperationSucceeded(response: AsyncResponse, suppressedErrors: StatusCode[] = []): void {
    try {
        getOperationPayload(response);
    } catch (e) {
        if (suppressedErrors.indexOf(e.constructor.status) > -1) {
            return;
        }

        if (!(e instanceof MissingValue)) {
            throw e;
        }
    }
}

export function pessimizable(_target: Pessimizable, _propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    descriptor.value = async function (this: Pessimizable, ...args: any) {
        try {
            return await originalMethod.call(this, ...args);
        } catch (error) {
            if (!(error instanceof NotFound)) {
                this.endpoint.pessimize();
            }
            throw error;
        }
    };
    return descriptor;
}
