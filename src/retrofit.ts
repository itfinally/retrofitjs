import Axios, { AxiosInstance } from "axios";
import {
  ArrayList,
  Assert,
  Exception,
  HashMap,
  IllegalArgumentException,
  IllegalStateException,
  Lang,
  List,
  Map
} from "jcdt";

import { RequestBuilder } from "./factory";
import { Proxy, ProxyHandler } from "./core/proxy";
import {
  ConnectException,
  IOException,
  RequestCancelException,
  RequestTimeoutException,
  SocketException
} from "./core/exception";
import { Decorators, MethodMetadata } from "./decorators";
import { RequestInterFace, RetrofitConfig, RetrofitPromise } from "./core/define";
import { ApplicationInterceptorChainActor, Interceptor, InterceptorChainActor } from "./core/interceptors";
import { LoggerInterceptor, RealCall, RetryRequestInterceptor } from "./functions";

interface RequestProxiesConfig {
  config: RetrofitConfig;
  errorHandler: ErrorHandler;
  interceptorActor: InterceptorChainActor;
}

module Proxies {
  let builder: RequestBuilder = new RequestBuilder(),
    handlers: List<( request: RequestInterFace, reason: any ) => Exception> = new ArrayList(),
    exceptionSelector = ( request: RequestInterFace, reason: any ): Error | null => {
      if ( reason instanceof Error ) {
        return reason;
      }

      if ( Lang.isNone( reason ) ) {
        return null;
      }

      let exception: Exception = <any>null;
      handlers.forEach( handler => ( exception = handler( request, reason ) ) !== null );

      return null === exception ? new IOException( reason.message ) : exception;
    };

  handlers.add( ( request, reason ) => !( "code" in reason ) && request.isCancel() ? new RequestCancelException( reason.message ) : <any>null );
  handlers.add( ( _, reason ) => "code" in reason && "ECONNREFUSED" === reason.code ? new ConnectException( reason.message ) : <any>null );
  handlers.add( ( _, reason ) => "code" in reason && "ECONNRESET" === reason.code ? new SocketException( reason.message ) : <any>null );
  handlers.add( ( _, reason ) => "code" in reason && "ECONNABORTED ETIMEDOUT".indexOf( reason.code ) >= 0 ? new RequestTimeoutException( reason.message ) : <any>null );

  export class RequestProxies<T = any> extends ProxyHandler<T> {
    private proxyCls: any;
    private readonly toolBox: RequestProxiesConfig;

    public constructor( box: RequestProxiesConfig ) {
      super();
      this.toolBox = box;
    }

    public construct( nativeCls: any, propKey: string, proxy: T ): T {
      let childPrototype = nativeCls.prototype,
        methods = this.scanningMethod( nativeCls.prototype );

      // Binding native class for type checking.
      this.proxyCls = nativeCls;

      // In order to make 'thisArg' parameter pointer to instance who activation 'apply' method,
      // should be overwrite prototype object of this instance, and added methods from all parent prototype,
      // also it can be avoided to traverse prototype chain when method called.
      let instance = new nativeCls();
      methods.forEach( name => instance[ name ] = Proxy.newProxy( childPrototype[ name ], this ) );

      return instance;
    }

    public apply( method: Function, thisArg: any, parameters: Array<any> ): RetrofitPromise {
      if ( this.proxyCls && !( thisArg instanceof this.proxyCls ) ) {
        throw new IllegalStateException(
          "Can not call with other object. ( should be binding with original class if is necessary )" );
      }

      let metadata: MethodMetadata = Decorators.getMetadata( thisArg.constructor, method.name ),
        request: RequestInterFace = builder.build( metadata, parameters ),
        box = this.toolBox,

        promise = box.interceptorActor.intercept( request ).catch( reason => {

          if ( box.errorHandler ) {
            box.errorHandler.handler( reason, exceptionSelector( request, reason ) );
          }

          return Promise.reject( reason );
        } );

      ( <any>promise ).cancel = ( message: string = "" ) => request.cancel( message );
      return <RetrofitPromise>promise;
    }

    private scanningMethod( prototype: any, methods: string[] = [] ): string[] {
      if ( prototype === Object.prototype ) {
        return methods.filter( name => name !== "constructor" );
      }

      return this.scanningMethod( Object.getPrototypeOf( prototype ), methods.concat( Object.getOwnPropertyNames( prototype ) ) );
    }
  }
}

interface RetrofitBuilder {
  config: RetrofitConfig;
  errorHandler: ErrorHandler;
  interceptors: Map<number, Interceptor>;
}

export interface ErrorHandler {
  handler( realReason: any, exception: Exception | null ): void;
}

export interface RetrofitBuilderFactory {
  setConfig<T extends RetrofitConfig = RetrofitConfig>( config: T ): this;

  getConfig<T extends RetrofitConfig = RetrofitConfig>(): T;

  setErrorHandler( handler: ErrorHandler ): this;

  getErrorHandler(): ErrorHandler;

  addInterceptor( ...interceptors: Interceptor[] ): this;

  getInterceptors(): Interceptor[];

  build(): Retrofit;
}

export class Retrofit {
  private static interceptors: Map<number, Interceptor> = new HashMap( 256 );

  private proxiesMap: Map<object, ProxyHandler<any>> = new HashMap( 16 );
  private interceptorActor: InterceptorChainActor;
  private errorHandler: ErrorHandler;
  private config: RetrofitConfig;
  private engine: AxiosInstance;

  private static Builder = class {
    private interceptors: Map<number, Interceptor> = new HashMap();
    private config: RetrofitConfig = Object.create( null );
    private errorHandler: ErrorHandler = <any>null;

    public setConfig<T extends RetrofitConfig = RetrofitConfig>( config: T ): this {
      this.config = config;
      return this;
    }

    public getConfig<T extends RetrofitConfig = RetrofitConfig>(): T {
      return <T>this.config;
    }

    public setErrorHandler( handler: ErrorHandler ): this {
      this.errorHandler = handler;
      return this;
    }

    public getErrorHandler(): ErrorHandler {
      return this.errorHandler;
    }

    public addInterceptor( ...interceptors: Interceptor[] ): this {
      Assert.requireNotNull( interceptors, "Interceptors must not be null." );

      let buf = this.interceptors;
      interceptors.forEach( interceptor => {
        if ( interceptor.order < 256 ) {
          throw new IllegalStateException( "Numbers less than 256 ( not including 256 ) are reserved" );
        }

        buf.put( interceptor.order, interceptor );
      } );

      return this;
    }

    public getInterceptors(): Interceptor[] {
      return this.interceptors.values().toArray();
    }

    public build(): Retrofit {
      let config = this.config;

      return new Retrofit( {
        config: this.config,
        errorHandler: this.errorHandler,
        interceptors: this.interceptors
      } );
    }
  };

  private constructor( configure: RetrofitBuilder ) {
    this.config = configure.config;

    this.interceptorActor = new ApplicationInterceptorChainActor();

    // add default interceptor
    this.engine = Axios.create( configure.config );

    let actor = this.interceptorActor,
      buf = Retrofit.interceptors,

      realCall = new RealCall( this.engine ),
      retries = new RetryRequestInterceptor(),
      logger = new LoggerInterceptor( "debug" in configure.config && <boolean>configure.config.debug );

    buf.put( realCall.order, realCall );
    buf.put( retries.order, retries );
    buf.put( logger.order, logger );

    // merge all interceptor and initializing
    buf.putAll( configure.interceptors );
    buf.values().forEach( interceptor => {
      interceptor.init( this.config );
      actor.addInterceptor( interceptor );
      return false;
    } );

    // clear up
    buf.clear();

    this.errorHandler = !Lang.isNone( configure.errorHandler ) ? configure.errorHandler : <any>null;
  }

  public getEngine(): AxiosInstance {
    return this.engine;
  }

  public static getBuilder(): RetrofitBuilderFactory {
    return new Retrofit.Builder();
  }

  public static use( ...interceptors: Interceptor[] ): void {
    Assert.requireNotNull( interceptors, "Interceptors must not be null." );

    let buf = Retrofit.interceptors;
    interceptors.forEach( interceptor => {
      if ( interceptor.order < 0 ) {
        throw new IllegalArgumentException( "Order field can not less than zero." );
      }

      buf.put( interceptor.order, interceptor );
    } );
  }

  public create<T>( cls: any ): T {
    if ( !( cls instanceof Object ) ) {
      throw new TypeError( `Expect class object but got ${typeof cls}` );
    }

    let proxies: ProxyHandler<T>,
      proxiesMap = this.proxiesMap;

    if ( proxiesMap.containsKey( cls ) ) {
      proxies = proxiesMap.get( cls );

    } else {
      proxies = new Proxies.RequestProxies( {
        config: this.config,
        errorHandler: this.errorHandler,
        interceptorActor: this.interceptorActor
      } );

      proxiesMap.put( cls, proxies );
    }

    // "Proxy.newProxy" will be return a proxy Class
    return new ( Proxy.newProxy<any>( cls, proxies ) )();
  }
}