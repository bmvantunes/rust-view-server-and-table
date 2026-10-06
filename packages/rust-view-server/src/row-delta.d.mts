import type {ProductResult} from './product-provider';
export type ReconstructedResult=ProductResult & {revision:number;contentVersion:number;windowId:number;effectiveEnd:number;projection:string[];keys:string[]};
export function reconstruct(prior:ProductResult|undefined,batch:unknown,contract?:{fieldPatches?:boolean;topic:string;schema:string;fields:readonly string[];key:string;validateKeys?(keys:string[],rows:Record<string,unknown>[]):void;validate(row:unknown,projection:readonly string[]):void}):ReconstructedResult;
