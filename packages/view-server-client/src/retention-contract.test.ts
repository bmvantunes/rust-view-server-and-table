import {expect,it} from 'vite-plus/test';
import {retentionDurationMs,validateRetentionPolicy} from './topic-schema';

it('converts bounded age to ceiling milliseconds and rejects unsafe values',()=>{
 expect(retentionDurationMs(1440)).toBe(86_400_000);
 expect(retentionDurationMs(0.00001)).toBe(1);
 for(const minutes of [0,-1,Number.NaN,Infinity,5_256_001])expect(()=>retentionDurationMs(minutes)).toThrow();
});

it('validates the count branch, positivity, integrality and maxRows budget',()=>{
 expect(()=>validateRetentionPolicy('delete',{maxRetentionMinutes:1440,maxRetentionMessages:50},100)).not.toThrow();
 expect(()=>validateRetentionPolicy('compact',{maxRetentionMessagesPerKey:4},100)).not.toThrow();
 expect(()=>validateRetentionPolicy('compact,delete',{maxRetentionMessagesPerKey:4},100)).not.toThrow();
 expect(()=>validateRetentionPolicy('delete',{maxRetentionMessagesPerKey:4},100)).toThrow(/requires source cleanupPolicy/);
 expect(()=>validateRetentionPolicy('compact',{maxRetentionMessages:4},100)).toThrow(/requires source cleanupPolicy/);
 expect(()=>validateRetentionPolicy('delete',{maxRetentionMessages:1.5},100)).toThrow();
 expect(()=>validateRetentionPolicy('delete',{maxRetentionMessages:101},100)).toThrow();
 expect(()=>validateRetentionPolicy('delete',{maxRetentionMessages:0},100)).toThrow();
 expect(()=>validateRetentionPolicy('delete',{maxRetentionMessages:1,maxRetentionMessagesPerKey:1},100)).toThrow(/mutually exclusive/);
 expect(()=>validateRetentionPolicy('compact',{maxRetentionMinutes:3,unboundedArchive:true},100)).toThrow();
 expect(()=>validateRetentionPolicy('delete',{},100)).toThrow(/at least one/);
});
