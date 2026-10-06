/** Executed by Node's native TypeScript support; Playwright comes from the SDK workspace. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {appendFileSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import type {catalog} from '../../packages/rust-view-server/src/generated/demo-catalog.ts';
import type {CompatRow} from '../../packages/table/src/rust/types.ts';
import type {HealthObservation} from '../../packages/rust-view-server/src/product-provider.tsx';
import type {queryCases} from '../../apps/web/src/e2e-queries.ts';

type SourceRow=CompatRow<typeof catalog.client_orders.schema>;
type SerializedRow=Omit<SourceRow,'units'|'price'> & {units:string;price:string};
type Diagnostic={snapshot():{client:{status:string;loaded:number;rows:readonly SerializedRow[]};server:{status:string;totalRows:number};health:HealthObservation;connection:string};dispose():void;queryCase:ReturnType<typeof queryCases>};
declare global {interface Window {__RVS_E2E__?:Diagnostic;__RVS_WORKERS__?:{active:number;resultRows:number;maximumResultRows:number};__RVS_FRAME_INTERVALS__?:number[]}}
type Expected=Record<string,{count:number;sha256:string;sourceNext:Record<string,number>;producerReceipts:number}>;
const require=createRequire(new URL('../../packages/rust-view-server/package.json',import.meta.url));
const {chromium}=require('playwright') as typeof import('playwright');
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=process.env.E2E_DIRECTORY!;
const rows=Number(process.env.E2E_ROWS);
const smoke=process.env.E2E_SMOKE==='true';
assert.equal(smoke?rows:200000,rows,'Full gate must run 200000/topic');
const checks:string[]=[];
const sample=(kind:string,value:unknown)=>appendFileSync(`${directory}/browser-samples.ndjson`,JSON.stringify({atMs:performance.now(),kind,value})+'\n');
let serial=0;
const waiting=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);waiting.get(message.id)?.resolve(message.result);waiting.delete(message.id);});
async function rpc(action:string,args:Record<string,unknown>={}):Promise<unknown>{const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiting.delete(id);reject(Error(`RPC deadline: ${action}`));},60000);waiting.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject});process.stdout.write(JSON.stringify({id,action,...args})+'\n');});}
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1000}});
await context.addInitScript(()=>{
 const intervals:number[]=[];window.__RVS_FRAME_INTERVALS__=intervals;let previous:number|undefined;const frame=(now:number)=>{if(previous!==undefined)intervals.push(now-previous);previous=now;if(intervals.length<2048)requestAnimationFrame(frame);};requestAnimationFrame(frame);
 const Original=window.Worker;const stats={active:0,resultRows:0,maximumResultRows:0};window.__RVS_WORKERS__=stats;
 window.Worker=class extends Original{
  private ended=false;
  constructor(url:string|URL,options?:WorkerOptions){super(url,options);stats.active++;this.addEventListener('message',(event:MessageEvent<unknown>)=>{
   const message=event.data;if(typeof message!=='object'||message===null||!('results'in message)||typeof message.results!=='object'||message.results===null)return;
   for(const value of Object.values(message.results)){if(typeof value!=='object'||value===null||!('rows'in value)||!Array.isArray(value.rows))continue;stats.resultRows+=value.rows.length;stats.maximumResultRows=Math.max(stats.maximumResultRows,value.rows.length);}
  });}
  terminate(){if(!this.ended){this.ended=true;stats.active--;}super.terminate();}
 };
});
const page=await context.newPage();
page.setDefaultTimeout(30000);
const cdp=await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Performance.enable');
let receivedBytes=0;
let responseBytes=0;
cdp.on('Network.webSocketFrameReceived',event=>{receivedBytes+=event.response.opcode===2?Buffer.from(event.response.payloadData,'base64').byteLength:Buffer.byteLength(event.response.payloadData);});
cdp.on('Network.loadingFinished',event=>{responseBytes+=event.encodedDataLength;});
const errors:string[]=[];
page.on('pageerror',error=>{errors.push(error.message);sample('pageerror',error.message);});
page.on('console',message=>{if(message.type()==='error')sample('console-error',message.text());});
let outcome='failed';
const begun=performance.now();
async function coherent(expected:Expected){
 await page.waitForFunction(expected=>{
  const value=window.__RVS_E2E__?.snapshot();if(!value)return false;
  if(value.client.status!=='ready'||value.client.loaded!==expected.client_orders.count||value.server.status!=='ready'||value.server.totalRows!==expected.server_orders.count||!value.health.snapshot?.ready)return false;
  for(const [topic,wanted]of Object.entries(expected)){
   const source=value.health.snapshot.sources.find(source=>source.topic===topic);
   if(!source)return false;
   for(const [partition,cut]of Object.entries(wanted.sourceNext)){
    const actual=source.partitions.find(value=>value.partition===Number(partition));
    if(!actual||!actual.assigned||!actual.bootstrap_complete||['durable_next','derived_next','serving_next'].some(key=>BigInt(Reflect.get(actual,key)??'-1')<BigInt(cut)))return false;
   }
  }return true;
 },expected,{timeout:240000});
 async function readMaterialized(){return page.evaluate(async()=>{
  const value=window.__RVS_E2E__!.snapshot();
  const rows=[...value.client.rows].sort((a,b)=>a.orderId<b.orderId?-1:a.orderId>b.orderId?1:0);
  function decimal(raw:string){
   const match=/^(-?)([0-9]+)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/i.exec(raw);if(!match)throw Error('Invalid diagnostic decimal');
   const digits=match[2]+(match[3]??'');const point=match[2].length+Number(match[4]??0);
   const plain=point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point);
   const [whole,fraction='']=plain.split('.');const integer=whole.replace(/^0+(?=.)/,'');const tail=fraction.replace(/0+$/,'');return match[1]+integer+(tail?'.'+tail:'');
  }
  const raw=rows.map(row=>{const {rowId,...fields}=row;const wire={...fields,price:decimal(row.price)};return `${row.orderId}\t${rowId}\t${JSON.stringify(Object.fromEntries(Object.entries(wire).sort(([a],[b])=>a<b?-1:a>b?1:0)))}`;}).join('\n');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
  return {count:rows.length,distinct:new Set(rows.map(row=>row.rowId)).size,sha256:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join(''),health:value.health,server:value.server,first:rows[0],last:rows.at(-1)};
 });}
 let summary=await readMaterialized();
 const deadline=performance.now()+60000;
 while(summary.sha256!==expected.client_orders.sha256&&performance.now()<deadline){await new Promise(resolve=>setTimeout(resolve,250));summary=await readMaterialized();}
 sample('coherent',summary);
 assert.equal(summary.count,expected.client_orders.count);
 assert.equal(summary.distinct,expected.client_orders.count);
 assert.equal(summary.sha256,expected.client_orders.sha256,'All client identities and full exact business payloads must match acknowledged inputs');
 return summary;
}
try{
 // Build preview starts asynchronously; retry only connection startup, not failed assertions.
 for(let attempt=0;;attempt++){
  try{await page.goto(process.env.E2E_URL!,{waitUntil:'domcontentloaded'});break;}
  catch(error){if(attempt>=30)throw error;await new Promise(resolve=>setTimeout(resolve,250));}
 }
 await page.waitForFunction(()=>Boolean(window.__RVS_E2E__),undefined,{timeout:120000});
 if(!smoke){
  await page.waitForFunction(()=>{const c=window.__RVS_E2E__!.snapshot().client;return c.status==='loading'&&c.loaded>0&&c.loaded<200000;},undefined,{timeout:30000});
  const before=await page.evaluate(()=>{const c=window.__RVS_E2E__!.snapshot().client;return {status:c.status,loaded:c.loaded};});
  sample('bootstrap-mutation-start',before);
  await rpc('bootstrap-update',{index:0,revision:2000000});
  const atCommit=await page.evaluate(()=>{const c=window.__RVS_E2E__!.snapshot().client;return {status:c.status,loaded:c.loaded};});
  sample('bootstrap-mutation-committed',atCommit);assert.equal(atCommit.status,'loading','Mutation commit must occur before bootstrap completes');
  checks.push('mutation-during-partial-bootstrap');
 }
 let expected=await rpc('expected') as Expected;
 let full=await coherent(expected);
 checks.push('producer-distinct-cuts-client-completeness');
 sample('first-coherent-ms',performance.now()-begun);
 const client=page.getByTestId('client-grid'),server=page.getByTestId('server-grid');
 assert.equal(await client.getByRole('grid').count(),1);
 assert.equal(await server.getByRole('grid').count(),1);
 const mounted=await server.locator('[data-bruno-row-id]').evaluateAll(nodes=>new Set(nodes.map(node=>node.getAttribute('data-bruno-row-id'))).size);
 assert(mounted>0&&mounted<500&&(smoke?mounted<=rows:mounted<rows),'Server mounted rows must remain sparse');
 sample('server-mounted-row-identities',mounted);
 const delivery=await page.evaluate(()=>window.__RVS_WORKERS__!);
 assert(delivery.maximumResultRows>0&&delivery.maximumResultRows<500&&(smoke?delivery.maximumResultRows<=rows:delivery.maximumResultRows<rows),'Worker must deliver bounded server windows');
 assert(delivery.resultRows<(smoke?1000:Math.min(rows,1000)),'Initial server must not preload full dataset');
 sample('server-worker-delivery-before-probes',delivery);
 // Actual UI scroll requests the deep viewport, with no bulk application row read.
 await server.getByRole('grid').evaluate(element=>{element.scrollTop=element.scrollHeight;});
 await server.getByText(`order-${String(rows-1).padStart(6,'0')}`,{exact:true}).first().waitFor();
 sample('deep-scroll',{logicalIndex:rows-1,orderId:`order-${String(rows-1).padStart(6,'0')}`});
 checks.push('simultaneous-grids-sparse-dom-deep-scroll');
 const serverFilter=server.getByRole('searchbox',{name:'Quick Filter'});
 const clientFilter=client.getByRole('searchbox',{name:'Quick Filter'});
 async function filterClient(value:string,count:number){
  await clientFilter.fill(value);
  await page.waitForFunction(count=>Number(document.querySelector('[data-testid="client-grid"] output[aria-label="Result rows"]')?.textContent?.replace(/\D/g,''))===count,count);
 }

 await serverFilter.fill('cafe');
 await page.waitForFunction(count=>window.__RVS_E2E__!.snapshot().server.totalRows===count,Math.ceil(rows/4)+Math.floor(rows/4),{timeout:60000});
 assert.equal(await clientFilter.inputValue(),'');
 assert.equal((await page.evaluate(()=>window.__RVS_E2E__!.snapshot().client.loaded)),rows);
 await serverFilter.fill('e2e-no-such-customer-unique');
 await page.waitForFunction(()=>window.__RVS_E2E__!.snapshot().server.totalRows===0);
 await serverFilter.fill('');
 await coherent(expected);
 await clientFilter.fill('e2e-no-such-customer-unique');
 await page.waitForFunction(()=>document.querySelector('[data-testid="client-grid"] [data-bruno-row-id]')===null);
 assert.equal((await page.evaluate(()=>window.__RVS_E2E__!.snapshot().server.totalRows)),rows);
 await filterClient('',expected.client_orders.count);
 checks.push('ui-quick-filter-unicode-match-none-peer-independence');
 for(const name of ['match-none','numeric-range','multi-sort','groups','facets']){
  const value=await page.evaluate(async name=>await window.__RVS_E2E__!.queryCase(name),name);
  sample(`query-${name}`,value);
  if(name==='match-none')assert.equal(value.totalRows,0);
  if(name==='numeric-range'){
   assert.equal(value.totalRows,10);
   assert.deepEqual(value.rows.map(row=>Reflect.get(row,'orderId')),Array.from({length:10},(_,i)=>`order-${String(i+10).padStart(6,'0')}`));
  }
  if(name==='facets'){
   assert.equal(value.totalRows,Math.min(rows,2048));
   const expected=new Map<string,number>();
   for(let i=0;i<rows;i++){const customer=i%2048;const name=`${['Café','東京','Straße','😀'][customer%4]}-${String(customer).padStart(4,'0')}`;expected.set(name,(expected.get(name)??0)+1);}
   assert.deepEqual(value.rows.map(row=>[Reflect.get(row,'customer'),String(Reflect.get(row,'count'))]),[...expected].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,count])=>[key,String(count)]));
  }
  if(name==='multi-sort'){
   assert.equal(value.totalRows,Math.min(rows,2048));
   for(let i=1;i<value.rows.length;i++){const a=value.rows[i-1],b=value.rows[i];assert(Number(Reflect.get(a,'open'))<Number(Reflect.get(b,'open'))||(Reflect.get(a,'open')===Reflect.get(b,'open')&&Reflect.get(a,'customer')>Reflect.get(b,'customer')));}
  }
  if(name==='groups'){
   assert.equal(value.totalRows,2);
   for(const group of value.rows){const parity=Reflect.get(group,'open')?0:1;let sum=0n;let count=0n;let price=0n;for(let i=parity;i<rows;i+=2){count++;sum+=9007199255740993n+BigInt(i);price+=BigInt(1000000+i%10000)*10n**20n+BigInt(`${String(i%100).padStart(2,'0')}123456789012345678`);}
    assert.equal(String(Reflect.get(group,'count')),String(count));assert.equal(String(Reflect.get(group,'units')),String(sum));
    // These deterministic group sizes divide exactly at scale 20, so no floating point oracle.
    assert.equal(price%count,0n);const average=price/count;const exact=`${average/10n**20n}.${String(average%10n**20n).padStart(20,'0')}`.replace(/0+$/,'').replace(/\.$/,'');assert.equal(String(Reflect.get(group,'price')),exact);
   }
  }
 }
 checks.push(`bounded-provider-numeric-multisort-groups-exact-average-${Math.min(rows,2048)}-facets`);
 // Exercise the Client's actual editing session and committed HTTP producer adapter.
 const clientGrid=client.getByRole('grid');
 await client.getByRole('switch',{name:'Batch editing',exact:true}).click();
 const findRow=async(orderId:string)=>page.evaluate(orderId=>{const row=window.__RVS_E2E__!.snapshot().client.rows.find(row=>row.orderId===orderId);if(!row)throw Error('Missing source identity');return row;},orderId);
 const identity3=(await findRow('order-000003')).rowId;
 const cell=(identity:string,column:string)=>clientGrid.locator(`[role="gridcell"][data-bruno-row-id=${JSON.stringify(identity)}][data-bruno-column-id=${JSON.stringify(column)}]`);
 async function stage(identity:string,column:string,label:string,value:string){
  await cell(identity,column).click();await page.keyboard.press('Enter');
  const editor=page.getByRole('textbox',{name:`Edit ${label}`,exact:true});
  await editor.fill(value);await page.keyboard.press('Enter');
 }
 async function save(){
  const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/save'&&response.request().method()==='POST');
  await client.getByRole('button',{name:'Save',exact:true}).click();
  assert.equal((await response).status(),200,'Save must acknowledge an actual atomic Kafka commit');
  expected=await rpc('expected') as Expected;await coherent(expected);
 }
 await filterClient('order-000003',1);
 await cell(identity3,'COL_ID_CUSTOMER').waitFor();
 const oldCustomer=(await findRow('order-000003')).customer;
 await stage(identity3,'COL_ID_CUSTOMER','Customer','e2e-saved-customer');
 assert.equal((await findRow('order-000003')).customer,oldCustomer,'A draft must not pretend to be a committed source write');
 await save();
 await page.waitForFunction(()=>window.__RVS_E2E__!.snapshot().client.rows.find(row=>row.orderId==='order-000003')?.customer==='e2e-saved-customer');
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 await cell(identity3,'COL_ID_CUSTOMER').click();
 await page.evaluate(()=>navigator.clipboard.writeText('e2e-pasted-customer'));
 await page.keyboard.press('ControlOrMeta+V');
 await cell(identity3,'COL_ID_CUSTOMER').getByText('e2e-pasted-customer',{exact:true}).waitFor();
 await save();
 await filterClient('order-00000',10);
 const identity4=(await findRow('order-000004')).rowId;
 await cell(identity3,'COL_ID_CUSTOMER').click();
 const fill=clientGrid.locator('[data-bruno-drag-fill-handle]');
 await fill.waitFor();
 const from=await fill.boundingBox(),to=await cell(identity4,'COL_ID_CUSTOMER').boundingBox();
 assert(from&&to,'Fill source and target are mounted');
 await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();
 await page.mouse.move(from.x+from.width/2,to.y+to.height/2,{steps:5});
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 sample('fill-gesture',{from,to,preview:await clientGrid.locator('[data-bruno-drag-fill-preview]').count()});
 await page.mouse.up();
 await cell(identity4,'COL_ID_CUSTOMER').getByText('e2e-pasted-customer',{exact:true}).waitFor();
 await save();
 // A concurrent source replacement must leave a draft visibly conflicted.
 await filterClient('order-000003',1);
 await stage(identity3,'COL_ID_UNITS','Exact units','9007199254999999');
 const conflict=await rpc('update',{index:3,revision:5000000}) as {expected:Expected};expected=conflict.expected;
 await page.waitForFunction(()=>window.__RVS_E2E__!.snapshot().client.rows.find(row=>row.orderId==='order-000003')?.units==='9007199259740996');
 await client.getByText(/conflict/i).first().waitFor();
 sample('draft-conflict-ui',await client.innerText());
 const resetEdits=client.getByRole('button',{name:'Reset edits',exact:true});
 await resetEdits.click();
 const confirm=page.getByRole('alertdialog');
 if(await confirm.count())await confirm.getByRole('button',{name:/reset/i}).last().click();
 await coherent(expected);
 await filterClient('',expected.client_orders.count);
 checks.push('client-edit-paste-fill-save-committed-source-draft-conflict');
 const moving=(await findRow('order-000005')).rowId;
 await clientGrid.evaluate(element=>{element.scrollTop=0;});
 const originalIndex=Number(await cell(moving,'COL_ID_ORDER').getAttribute('data-bruno-row-index'));
 await clientGrid.getByRole('checkbox',{name:`Select row ${originalIndex+1}`,exact:true}).check();
 const moved=await rpc('update',{index:5,revision:3000000}) as {expected:Expected};expected=moved.expected;await coherent(expected);
 await clientGrid.evaluate(element=>{element.scrollTop=element.scrollHeight;});
 await cell(moving,'COL_ID_ORDER').waitFor();
 const movedIndex=Number(await cell(moving,'COL_ID_ORDER').getAttribute('data-bruno-row-index'));
 assert.notEqual(movedIndex,originalIndex,'Live source sort changes must move the row');
 const movedCheckbox=clientGrid.getByRole('checkbox',{name:`Select row ${movedIndex+1}`,exact:true});
 assert.equal(await movedCheckbox.isChecked(),true,'Selection follows authoritative rowId across reorder');
 await movedCheckbox.uncheck();
 checks.push('selected-row-identity-survives-live-reorder');
 const stableIdentity=full.first.rowId;
 const liveUpdateStarted=performance.now();
 const changed=await rpc('update',{index:0,revision:3000000}) as {expected:Expected};
 expected=changed.expected;full=await coherent(expected);assert.equal(full.first.rowId,stableIdentity);
 // Visible observation uses a real table quick filter on the topic-specific note.
 await filterClient('order-000000',1);
 await client.getByText('order-000000',{exact:true}).first().waitFor();
 await page.waitForFunction(({identity,value})=>Array.from(document.querySelectorAll('[data-testid="client-grid"] [role="gridcell"][data-bruno-column-id="COL_ID_UNITS"]')).some(cell=>cell.getAttribute('data-bruno-row-id')===identity&&cell.textContent?.replace(/\D/g,'')===value),{identity:stableIdentity,value:full.first.units});
 sample('source-update-request-to-observed-dom-ms',performance.now()-liveUpdateStarted);
 await filterClient('',expected.client_orders.count);
 const deleted=await rpc('delete',{index:1}) as {expected:Expected};expected=deleted.expected;await coherent(expected);
 checks.push('live-upsert-exact-dom-stable-identity-delete');
 await context.setOffline(true);
 await page.waitForFunction(()=>window.__RVS_E2E__!.snapshot().connection!=='connected',undefined,{timeout:30000});
 await context.setOffline(false);
 await coherent(expected);checks.push('same-page-transport-interruption-recovery');
 const instance=await page.evaluate(()=>window.__RVS_E2E__!.snapshot().health.snapshot?.instance);
 await rpc('restart');
 await page.waitForFunction(instance=>{const value=window.__RVS_E2E__!.snapshot();return value.health.snapshot?.instance!==instance&&value.health.snapshot?.ready;},instance,{timeout:240000});
 await coherent(expected);
 const later=await rpc('update',{index:2,revision:4000000}) as {expected:Expected};expected=later.expected;await coherent(expected);
 checks.push('owned-native-restart-recovery-later-update');
 const intervals=await page.evaluate(()=>window.__RVS_FRAME_INTERVALS__??[]);
 sample('animation-frame-intervals-ms',intervals);
 sample('frame-cadence-summary',{samples:intervals.length,over32ms:intervals.filter(value=>value>32).length,estimatedMissed60HzOpportunities:intervals.reduce((sum,value)=>sum+Math.max(0,Math.round(value/(1000/60))-1),0),assumption:'60Hz requestAnimationFrame opportunities, not physical dropped paints'});
 sample('native-memory',await rpc('native-memory'));
 sample('browser-performance',await cdp.send('Performance.getMetrics'));
 sample('application-bytes',{websocketReceived:receivedBytes,httpEncoded:responseBytes});
 // Block worker/WASM assets separately from the above transport-only interruption.
 await context.route(/(?:worker[^/]*\.(?:js|ts)|\.wasm)(?:\?.*)?$/i,route=>route.abort('failed'));
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>{const s=window.__RVS_E2E__?.snapshot();return s&&(s.client.status==='error'||s.server.status==='error'||s.connection==='error');},undefined,{timeout:45000});
 await context.unrouteAll({behavior:'wait'});
 await page.getByRole('button',{name:'Reconnect and reacquire'}).click();
 await coherent(expected);checks.push('worker-asset-failure-bounded-error-explicit-retry');
 await page.evaluate(()=>window.__RVS_E2E__!.dispose());
 await page.waitForFunction(()=>window.__RVS_E2E__!.snapshot().connection==='disconnected'&&window.__RVS_WORKERS__?.active===0);
 await page.goto('about:blank');
 assert.deepEqual(errors,[],'Unexpected uncaught browser exceptions');
 checks.push('provider-disposal-page-unmount');
 outcome='passed';
}catch(error){writeFileSync(`${directory}/failure-dom.html`,await page.content().catch(()=>''));sample('failure',{message:String(error),stack:error instanceof Error?error.stack:undefined});throw error;}
finally{
 await context.close();await browser.close();
 writeFileSync(`${directory}/browser-result.json`,JSON.stringify({status:outcome,smoke,rowsPerTopic:rows,checks,seconds:(performance.now()-begun)/1000,root,limits:['provider query probes do not certify every equivalent menu interaction','no physical paint or production SLA claim']},null,2)+'\n');
 process.stdin.destroy();
}
