import {useCallback,useEffect,useState} from "react";
import {catalog} from "@bruno/rust-view-server/generated/demo-catalog";
import {BrunoTableBigIntColumn,BrunoTableBooleanColumn,BrunoTableTextColumn,type BrunoTableColumns,type BrunoTableSaveEditsHandler} from "@bruno/table";
import {BrunoTableBigDecimalColumn,type BrunoTableBigDecimalValueType} from "@bruno/table/effect";
import {encodeCompatRow,type CompatRow} from "@bruno/table/rust";

export type OrderRow=CompatRow<typeof catalog.client_orders.schema>;
// Checked helper outputs retain exact field/edit capabilities without carrying
// the helpers' broad conditional metadata into save-change inference.
const orderOptions={columnId:"COL_ID_ORDER",field:"orderId",headerName:"Order",width:180,isEditable:false} as const;
const orderColumn: typeof orderOptions & { readonly valueType: "text" } = BrunoTableTextColumn<OrderRow,"orderId","COL_ID_ORDER",typeof orderOptions>(orderOptions);
const customerOptions={columnId:"COL_ID_CUSTOMER",field:"customer",headerName:"Customer",width:190,enableSetFilter:true,isEditable:true} as const;
const customerColumn: typeof customerOptions & { readonly valueType: "text" } = BrunoTableTextColumn<OrderRow,"customer","COL_ID_CUSTOMER",typeof customerOptions>(customerOptions);
const openOptions={columnId:"COL_ID_OPEN",field:"open",headerName:"Open",isEditable:true} as const;
const openColumn: typeof openOptions & { readonly valueType: "boolean" } = BrunoTableBooleanColumn<OrderRow,"open","COL_ID_OPEN",typeof openOptions>(openOptions);
const unitsOptions={columnId:"COL_ID_UNITS",field:"units",headerName:"Exact units",width:230,isEditable:true} as const;
const unitsColumn: typeof unitsOptions & { readonly valueType: "bigint" } = BrunoTableBigIntColumn<OrderRow,"units","COL_ID_UNITS",typeof unitsOptions>(unitsOptions);
const priceOptions={columnId:"COL_ID_PRICE",field:"price",headerName:"Exact price",width:300,isEditable:true} as const;
const priceColumn: typeof priceOptions & { readonly valueType: typeof BrunoTableBigDecimalValueType } = BrunoTableBigDecimalColumn<OrderRow,"price","COL_ID_PRICE",typeof priceOptions>(priceOptions);
const noteOptions={columnId:"COL_ID_NOTE",field:"note",headerName:"Note",width:280,isEditable:true,blankValue:null} as const;
const noteColumn: typeof noteOptions & { readonly valueType: "text" } = BrunoTableTextColumn<OrderRow,"note","COL_ID_NOTE",typeof noteOptions>(noteOptions);
export const editableColumns=[orderColumn,customerColumn,openColumn,unitsColumn,priceColumn,noteColumn] as const satisfies BrunoTableColumns<OrderRow>;

export const identifyOrder=(row:OrderRow)=>row.rowId;
// Source schema has no revision field: the exact canonical source content is the
// opaque row version. The service separately compares the full expected wire row.
export const orderVersion=(row:OrderRow)=>JSON.stringify(encodeCompatRow(catalog.client_orders.schema,row));

async function postControl(path:string,body:unknown):Promise<void>{
 const url=import.meta.env.VITE_RVS_CONTROL_URL,token=import.meta.env.VITE_RVS_CONTROL_TOKEN;
 if(!url||!token)throw Error("Start the local workspace controls before saving changes.");
 const response=await fetch(new URL(path,url),{method:"POST",headers:{"Content-Type":"application/json","X-RVS-Token":token},body:JSON.stringify(body)});
 if(!response.ok){if(response.status===409)throw Error("The source changed before this save. Review the live conflict and try again.");throw Error(`The local source rejected this operation (${response.status}).`);}
}

function failureMessage(error:unknown):string{return error instanceof Error?error.message:"The source operation failed.";}

export function useOrderEditing(){
 const [saveStatus,setSaveStatus]=useState("Edit a cell, paste values or drag to fill. Save publishes changes to the live source.");
 const onSaveEdits=useCallback<BrunoTableSaveEditsHandler<OrderRow,typeof editableColumns,string>>(async changes=>{
  const payload=changes.map(change=>{
   if(change.expectedVersion!==orderVersion(change.baseRow))throw Error("The save no longer matches its source row.");
   let updated=change.baseRow;
   for(const cell of change.changes){
    switch(cell.field){
     case "customer":updated={...updated,customer:cell.after};break;
     case "open":updated={...updated,open:cell.after};break;
     case "units":updated={...updated,units:cell.after};break;
     case "price":updated={...updated,price:cell.after};break;
     case "note":updated={...updated,note:cell.after};break;
    }
   }
   return {rowId:change.rowId,orderId:change.baseRow.orderId,expected:encodeCompatRow(catalog.client_orders.schema,change.baseRow),row:encodeCompatRow(catalog.client_orders.schema,updated)};
  });
  setSaveStatus("Saving to the live source…");
  try{await postControl("/save",{topic:"client_orders",changes:payload});setSaveStatus("Accepted. Waiting for the authoritative live update.");}
  catch(error){setSaveStatus(failureMessage(error));throw error;}
 },[]);
 return {onSaveEdits,getRowVersion:orderVersion,saveStatus};
}

async function runControl(path:string,body:unknown,setPending:(value:boolean)=>void,setStatus:(value:string)=>void){
 setPending(true);try{await postControl(path,body);setStatus("Source change accepted. The tables will update from Kafka.");}catch(error){setStatus(error instanceof Error?error.message:"Source operation failed.");}finally{setPending(false);}
}

function pacedUpdates(index:number,report:(value:string)=>void){
 let stopped=false,revision=1,timer:ReturnType<typeof setTimeout>|undefined;
 const tick=async()=>{try{await postControl("/update",{topic:"client_orders",index,revision:revision++});if(!stopped)report("Paced source update accepted.");}catch(error){if(!stopped)report(failureMessage(error));stopped=true;}if(!stopped)timer=setTimeout(tick,1000);};
 timer=setTimeout(tick,1000);return()=>{stopped=true;if(timer!==undefined)clearTimeout(timer);};
}

export function SourceControls({row}:{readonly row:OrderRow|undefined}){
 const [status,setStatus]=useState(""),[pending,setPending]=useState(false),[paced,setPaced]=useState(false);
 const match=row?.orderId.match(/^order-(\d+)$/);
 const index=match?Number(match[1]):undefined;
 const validIndex=index!==undefined&&Number.isSafeInteger(index)&&index>=0&&index<200000;
 useEffect(()=>{if(paced&&validIndex)return pacedUpdates(index,setStatus);},[paced,validIndex,index]);
 const runId=import.meta.env.VITE_RVS_RUN;
 const run=(path:string,body:unknown)=>runControl(path,body,setPending,setStatus);
 return <div className="source-controls" aria-label="Local source controls">
  <p>First source row: {row?.orderId??"waiting for a complete source"}</p>
  <button disabled={!validIndex||pending} onClick={()=>{if(validIndex)void run("/update",{topic:"client_orders",index});}}>Update source row</button>
  <button disabled={!validIndex||pending} onClick={()=>{if(validIndex)void run("/delete",{topic:"client_orders",index});}}>Delete source row</button>
  <button disabled={!validIndex||pending} onClick={()=>setPaced(value=>!value)}>{paced?"Stop paced updates":"Start paced updates"}</button>
  <button disabled={pending||!runId} onClick={()=>void run("/reset",{confirmRun:runId})}>Reset both sources</button>
  <p role="status">{status}</p>
 </div>;
}
