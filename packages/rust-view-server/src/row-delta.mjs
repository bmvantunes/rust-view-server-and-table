import {validRowId} from './row-id.mjs';
// Shared by the actual Worker and independent reconstruction tests. No query evaluation.
const fields=['id','category','label','quantity','amount'];
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=v=>typeof v==='string'&&v.length<=10001&&/^(0|-[1-9]\d*|[1-9]\d*)$/.test(v);
function row(r,projection){
 if(!object(r)||Object.keys(r).length!==projection.length||!projection.every(f=>Object.hasOwn(r,f)))throw Error('incomplete/extra projected payload');
 for(const f of projection){const v=r[f];
  if((f==='id'&&(typeof v!=='string'||!v.length||v.length>512))||(f==='category'&&(typeof v!=='string'||v.length>256))||(f==='quantity'&&!exact(v)))throw Error('projected scalar');
  if(f==='amount'&&(!object(v)||Object.keys(v).length!==2||!exact(v.coefficient)||!Number.isInteger(v.scale)||Math.abs(v.scale)>10000||(v.coefficient==='0'&&v.scale!==0)||(v.scale> -10000&&v.coefficient!=='0'&&v.coefficient.endsWith('0'))))throw Error('projected decimal');
  if(f==='label'&&(!object(v)||!(['missing','null'].includes(v.state)&&Object.keys(v).length===1||v.state==='value'&&Object.keys(v).length===2&&typeof v.value==='string'&&v.value.length<=4096)))throw Error('projected label');
 }
 return r;
}
// Copy only paths touched by the staged patch. The old row/base stays immutable.
function patchRow(original,changes,projection){
 if(!Array.isArray(changes)||!changes.length||changes.length>512)throw Error('patch changes bound');
 let result=original;const seen=new Set();
 for(const change of changes){
  if(!object(change)||typeof change.path!=='string'||change.path.length>512||seen.has(change.path))throw Error('patch path');
  seen.add(change.path);const parts=change.path.split('.');
  if(parts.length>8||parts.some(p=>!(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).test(p)||['rowId','__proto__','constructor','prototype'].includes(p)))throw Error('patch path');
  const leaf=projection.includes(change.path),parent=projection.some(p=>p.startsWith(change.path+'.'));
  if(change.type==='set'?(!leaf||Object.keys(change).length!==3||!Object.hasOwn(change,'value')):(!['remove','object'].includes(change.type)||Object.keys(change).length!==2||!leaf&&!parent||change.type==='object'&&!parent))throw Error('patch selected shape');
  const root=Object.assign(Object.create(Object.getPrototypeOf(result)),result);let target=root,source=result;
  for(const part of parts.slice(0,-1)){
   if(!Object.hasOwn(source,part)||!object(source[part]))throw Error('patch absent parent');
   target[part]=Object.assign(Object.create(Object.getPrototypeOf(source[part])),source[part]);source=source[part];target=target[part];
  }
  const key=parts.at(-1);
  if(change.type==='remove'){if(!Object.hasOwn(target,key))throw Error('patch absent remove');delete target[key];}
  else if(change.type==='object'){if(Object.hasOwn(target,key))throw Error('patch parent already present');target[key]=Object.create(null);}
  else target[key]=change.value;
  result=root;
 }
 return result;
}
export function reconstruct(prior,batch,contract){
 const allowed=contract?.fields??fields;
 const payload=(r,projection)=>{if(contract){contract.validate(r,projection);return r;}return row(r,projection);};
 if(contract&&(batch?.topic!==contract.topic||batch?.schema!==contract.schema||prior&&(prior.topic!==batch.topic||prior.schema!==batch.schema||prior.result_kind!==batch.result_kind||prior.result_shape!==batch.result_shape)))throw Error('dataset mismatch');
 if(!object(batch)||typeof batch.subscription!=='string'||!['query_generation','sequence','start_rank','version','total_rows','revision','contentVersion','windowId','effectiveEnd'].every(k=>integer(batch[k]))||batch.revision===0||!Array.isArray(batch.projection)||!batch.projection.length||batch.projection.length>allowed.length||new Set(batch.projection).size!==batch.projection.length||!batch.projection.every(f=>allowed.includes(f)))throw Error('batch metadata');
 let keys,rows;
 if(batch.kind==='snapshot'){
  if(batch.operations!==undefined||!Array.isArray(batch.keys)||!Array.isArray(batch.rows)||batch.keys.length!==batch.rows.length||batch.keys.length>1024)throw Error('snapshot shape');
  keys=batch.keys.slice();rows=batch.rows.map(r=>payload(r,batch.projection));
  if(prior&&batch.revision<=prior.revision)throw Error('stale snapshot');
 }else if(batch.kind==='delta'){
  if(!prior||batch.fromRevision!==prior.revision||batch.revision!==prior.revision+1||batch.fromVersion!==prior.contentVersion||batch.toVersion!==batch.contentVersion||batch.contentVersion<prior.contentVersion||batch.subscription!==prior.subscription||batch.query_generation!==prior.query_generation||batch.start_rank!==prior.start_rank||batch.windowId!==prior.windowId||JSON.stringify(batch.projection)!==JSON.stringify(prior.projection))throw Error('unavailable delta base');
  if(batch.rows!==undefined||batch.keys!==undefined||!Array.isArray(batch.operations)||batch.operations.length>4096)throw Error('delta shape');
  keys=prior.keys.slice();rows=prior.rows.slice();
  for(const op of batch.operations){
   if(!object(op)||typeof op.key!=='string')throw Error('operation shape');
   const index=keys.indexOf(op.key);
   switch(op.type){
    case 'remove':if(Object.keys(op).length!==2||index<0)throw Error('remove key');keys.splice(index,1);rows.splice(index,1);break;
    case 'insert':if(Object.keys(op).length!==4||index!==-1||!integer(op.index)||op.index>keys.length||keys.length>=1024)throw Error('insert index/key');keys.splice(op.index,0,op.key);rows.splice(op.index,0,payload(op.row,batch.projection));break;
    case 'update':if(Object.keys(op).length!==4||!integer(op.index)||op.index>=keys.length||index!==op.index)throw Error('update index/key');rows[op.index]=payload(op.row,batch.projection);break;
    case 'patch':if(!contract?.fieldPatches||Object.keys(op).length!==4||!integer(op.index)||op.index>=keys.length||index!==op.index)throw Error('patch capability/index/key');rows[op.index]=payload(patchRow(rows[op.index],op.changes,batch.projection),batch.projection);break;
    case 'move':if(Object.keys(op).length!==4||!integer(op.fromIndex)||!integer(op.toIndex)||op.fromIndex>=keys.length||op.toIndex>=keys.length||index!==op.fromIndex)throw Error('move index/key');keys.splice(op.fromIndex,1);const moved=rows.splice(op.fromIndex,1)[0];keys.splice(op.toIndex,0,op.key);rows.splice(op.toIndex,0,moved);break;
    default:throw Error('unknown operation');
   }
  }
 }else throw Error('unknown batch kind');
 if(contract?.validateKeys)contract.validateKeys(keys,rows);
 if(!contract?.validateKeys&&contract?.key==='rowId'&&keys.some(k=>!validRowId(k)))throw Error('malformed canonical rowId');
 if(batch.effectiveEnd!==batch.start_rank+rows.length||keys.length!==rows.length||keys.length>1024||new Set(keys).size!==keys.length||keys.some(k=>typeof k!=='string'||!k.length||new TextEncoder().encode(k).length>512||/[\u0000-\u001f\u007f-\u009f]/.test(k)||new TextDecoder('utf-8',{ignoreBOM:true}).decode(new TextEncoder().encode(k))!==k)||!Number.isSafeInteger(batch.start_rank+rows.length)||(rows.length>0&&batch.start_rank+rows.length>batch.total_rows)||batch.projection.includes(contract?.key??'id')&&rows.some((r,i)=>r[contract?.key??'id']!==keys[i]))throw Error('window/key bounds');
 return {...batch,keys,rows,operations:undefined};
}
