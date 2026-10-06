import {createElement,StrictMode} from 'react';
import {it,expect} from 'vite-plus/test';
import {render} from 'vitest-browser-react';
import {BrowserProductProvider,ProductProvider,useProductLiveQuery} from './product-provider';
function View({id}:{id:number}){const q=useProductLiveQuery('local-'+id,{where_expr:{op:'true'},direction:'ascending',offset:0,limit:1});return createElement('output',{'data-testid':'local-'+id},q.error?'error':q.data?'ready':'loading');}
it('preserves local cold admission for 20 mounted unique hooks through StrictMode and cleanup',async()=>{
 const provider=new BrowserProductProvider();const screen=await render(createElement(StrictMode,null,createElement(ProductProvider,{provider,children:Array.from({length:20},(_,id)=>createElement(View,{key:id,id}))})));
 try{for(let id=0;id<20;id++)await expect.element(screen.getByTestId('local-'+id)).toHaveTextContent('ready');expect(provider.admission.subscriptions).toBe(20);}
 finally{await screen.unmount();await expect.poll(()=>provider.admission.outstanding).toBe(0);expect(provider.admission.subscriptions).toBe(0);provider.dispose();}
});
