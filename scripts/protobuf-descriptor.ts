/** Narrow declarations for protobufjs's official descriptor extension (which ships no API declarations). */
import pb from 'protobufjs';
import {createRequire} from 'node:module';
export const require=createRequire(import.meta.url);
export {pb};
export interface DescriptorField {name:string;options?:unknown;typeName?:string;[key:string]:unknown}
export interface DescriptorMessage {name:string;field:DescriptorField[];nestedType?:DescriptorMessage[];options?:unknown;[key:string]:unknown}
export interface DescriptorFile {name:string;package?:string;syntax?:string;messageType:DescriptorMessage[];options?:unknown;[key:string]:unknown}
export interface DescriptorSet {file:DescriptorFile[]}
interface DescriptorExtension {FileDescriptorSet:{create(input:DescriptorSet):DescriptorSet;encode(input:DescriptorSet):{finish():Uint8Array}}}
// This boundary describes a pinned third-party API, not a second declaration of first-party implementation.
export const descriptor=require('protobufjs/ext/descriptor') as DescriptorExtension;
declare module 'protobufjs' {interface Type {toDescriptor(syntax:string):DescriptorMessage} interface Root {toDescriptor(syntax:string):DescriptorSet}}
export function options(value:pb.ReflectionObject):Readonly<Record<string,unknown>> {return value.options??{};}
export function flag(value:pb.ReflectionObject,key:string):boolean {const v=options(value)[key];if(v===undefined)return false;if(typeof v!=='boolean')throw Error('boolean metadata required: '+key);return v;}
export function packageVersion():string{const value:unknown=require('protobufjs/package.json');if(!value||typeof value!=='object'||!('version'in value)||typeof value.version!=='string')throw Error('protobufjs package version');return value.version;}
export type ScalarKind='string'|'boolean'|'number'|'int64'|'uint64'|'decimal'|'enum';
export interface FieldDefinition {name:string;kind:ScalarKind;optional:boolean;nullable:boolean}
export interface GeneratedSchema {format:number;id:string;version:number;key:string;fields:FieldDefinition[]}
export interface DescriptorBinding {schema_id:number;message_index:number;descriptor_hex:string;message_name?:string}
export interface KeyField {name:string;tag:number;kind:ScalarKind}
export interface Mapping {field:string;tag:number;null_tag?:number}
