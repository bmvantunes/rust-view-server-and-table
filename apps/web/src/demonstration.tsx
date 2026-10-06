import {editableColumns,useOrderEditing,SourceControls} from "./editing";
import {queryCases} from "./e2e-queries";
import * as BigDecimal from "effect/BigDecimal";
import { useEffect, useState, useSyncExternalStore } from "react";
import { BrowserProductProvider } from "@bruno/view-server-client/react";
import { catalog } from "@bruno/view-server-client/generated/demo-catalog";
import { BrunoTableClient, type BrunoTableColumns } from "@bruno/table";
import { BrunoTableServer, BrunoTableBigIntColumn, BrunoTableBooleanColumn, BrunoTableToolbar, BrunoTableQuickFilter, BrunoTableLoadedRowCount, BrunoTableResultRowCount } from "@bruno/table/server";
import { BrunoTableBigDecimalColumn } from "@bruno/table/effect";
import { createBrunoTableHooks, type CompatRow } from "@bruno/table/rust";
const hooks=createBrunoTableHooks(catalog);
type Row=CompatRow<typeof catalog.client_orders.schema>;
type DisplayFieldColumn<F extends keyof Row>=Extract<BrunoTableColumns<Row>[number],{readonly field:F}> ;
const columns=[
 {columnId:"COL_ID_ORDER",field:"orderId",headerName:"Order",valueType:"text",width:180} satisfies DisplayFieldColumn<"orderId">,
 {columnId:"COL_ID_CUSTOMER",field:"customer",headerName:"Customer",valueType:"text",width:190,enableSetFilter:true} satisfies DisplayFieldColumn<"customer">,
 BrunoTableBooleanColumn({columnId:"COL_ID_OPEN",field:"open",headerName:"Open"}) satisfies DisplayFieldColumn<"open">,
 BrunoTableBigIntColumn({columnId:"COL_ID_UNITS",field:"units",headerName:"Exact units",width:230}) satisfies DisplayFieldColumn<"units">,
 BrunoTableBigDecimalColumn({columnId:"COL_ID_PRICE",field:"price",headerName:"Exact price",width:300}) satisfies DisplayFieldColumn<"price">,
 {columnId:"COL_ID_NOTE",field:"note",headerName:"Note",valueType:"text",width:280} satisfies DisplayFieldColumn<"note">,
] as const satisfies BrunoTableColumns<Row>;
const identify=(row:Row)=>row.rowId;
const diagnosticRow=(row:Row)=>({rowId:row.rowId,orderId:row.orderId,customer:row.customer,units:row.units.toString(),price:BigDecimal.format(row.price),open:row.open,...(Object.hasOwn(row,"note")?{note:row.note}:{})});
function Tables({provider}:{provider:BrowserProductProvider}){
 const editing=useOrderEditing();
 const client=hooks.useCompleteSource(provider,"client_orders");
 const server=hooks.useViewportSource(provider,"server_orders");
 const connection=useSyncExternalStore(provider.subscribeConnectionStatus,provider.getConnectionStatus,provider.getConnectionStatus);
 const health=useSyncExternalStore(provider.subscribeHealth,provider.getHealthSnapshot,provider.getHealthSnapshot);
 useEffect(()=>{
  if(import.meta.env.VITE_RVS_E2E!=="1")return;
  const status=()=>({client:{status:client.status,loaded:client.loaded,error:client.error},server:{status:server.status,totalRows:server.totalRows,message:server.message},health:provider.getHealthSnapshot(),connection:provider.getConnectionStatus(),diagnostics:provider.connectionDiagnostics,recoveryEvents:provider.recoveryEvents.slice(-32)});
  const diagnostic={queryCase:queryCases(provider),status,row:(orderId:string)=>{const row=client.rows.find(row=>row.orderId===orderId);return row?diagnosticRow(row):undefined;},snapshot:()=>({...status(),client:{...status().client,rowIds:client.rows.map(row=>row.rowId),rows:client.rows.map(diagnosticRow)}}),dispose:()=>provider.dispose()};
  Object.assign(window,{__RVS_E2E__:diagnostic});return()=>{if(Reflect.get(window,"__RVS_E2E__")===diagnostic)Reflect.deleteProperty(window,"__RVS_E2E__");};
 },[client,server.status,server.totalRows,server.message,provider]);
 return <><div className="status" data-testid="status">Connection: {connection} · Dependencies: {health.status} · Native ready: {String(health.snapshot?.ready??false)}</div>
 <div className="grids"><section data-testid="client-grid"><div className="panel-title"><h2>Client</h2><span>Complete dataset · local operations</span></div>
 <p data-testid="client-count">{client.status} · acquired {client.loaded.toLocaleString()} rows{client.status==="ready"?" · complete dataset":" · completion pending"}{client.error?` · ${client.error}`:""}</p>
 <div className="table-frame"><BrunoTableClient tableId="client-orders" columns={editableColumns} quickFilterFields={["orderId","customer","note"]} rowSelection editable getRowVersion={editing.getRowVersion} onSaveEdits={editing.onSaveEdits} getRowId={identify} initialOrderBy={[{columnId:"COL_ID_UNITS",direction:"asc"}]} clientSource={client}>
 <BrunoTableToolbar><BrunoTableQuickFilter/><BrunoTableLoadedRowCount/><BrunoTableResultRowCount/></BrunoTableToolbar>
 </BrunoTableClient></div><p role="status">{editing.saveStatus}</p><SourceControls row={client.rows[0]}/></section>
 <section data-testid="server-grid"><div className="panel-title"><h2>Server</h2><span>Sparse windows · Rust operations</span></div>
 <p data-testid="server-count">{server.status} · total {server.totalRows.toLocaleString()}{server.message?` · ${server.message}`:""}</p>
 <div className="table-frame"><BrunoTableServer tableId="server-orders" columns={columns} initialOrderBy={[{columnId:"COL_ID_UNITS",direction:"asc"}]} viewportSource={server} quickFilterFields={["customer","note"]}>
 <BrunoTableToolbar><BrunoTableQuickFilter/><BrunoTableLoadedRowCount/><BrunoTableResultRowCount/></BrunoTableToolbar>
 </BrunoTableServer></div></section></div>
 <details><summary>Source progress and dependency health</summary><pre>{JSON.stringify(health,null,2)}</pre></details></>;
}
export function Demonstration(){
 const [retry,setRetry]=useState(0);
 const [provider,setProvider]=useState<BrowserProductProvider>();const [error,setError]=useState("");
 useEffect(()=>{const url=import.meta.env.VITE_RVS_URL,token=import.meta.env.VITE_RVS_TOKEN;if(!url||!token){setError("Start this workspace with vp run dev to connect the private broker and native service.");return;}
  const instance=new BrowserProductProvider({mode:"remote",url,token,catalog,subscriptions:16,fieldPatches:false});setProvider(instance);return()=>instance.dispose();},[retry]);
 return <main><header><p className="eyebrow">LOCAL DATA WORKSPACE</p><h1>One source of truth. Two ways to explore.</h1><p>Two independent Kafka topics. Full campaign target: 200,000 live identities in each. Shared provider, exact values, stable identity.</p></header>
 <button onClick={()=>setRetry(value=>value+1)}>Reconnect and reacquire</button>
 {error?<p role="alert">{error}</p>:provider?<Tables provider={provider}/>:<p>Connecting…</p>}
 </main>;
}
