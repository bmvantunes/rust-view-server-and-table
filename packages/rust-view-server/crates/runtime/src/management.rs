//! Independent HTTP runtime. Every handler reads local cached state only.
use crate::{health::Health,telemetry::Telemetry};
use std::{convert::Infallible,sync::Arc,time::Duration};
use bytes::Bytes;
use http_body_util::Full;
use hyper::{Request,Response,body::Incoming,service::service_fn,server::conn::http1};
use hyper_util::rt::{TokioIo,TokioTimer};

pub struct Management { done:std::sync::mpsc::Receiver<()>, stop:Option<tokio::sync::oneshot::Sender<()>> }
impl Management {
    pub fn start(health:Arc<Health>,telemetry:Arc<Telemetry>,token:String)->Result<Self,String>{
        let listener=std::net::TcpListener::bind(health.config.bind).map_err(|e|e.to_string())?;listener.set_nonblocking(true).map_err(|e|e.to_string())?;
        let(stop,mut stopped)=tokio::sync::oneshot::channel();let(done_tx,done)=std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move||{
            let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(async move{
                let listener=tokio::net::TcpListener::from_std(listener).unwrap();let slots=Arc::new(tokio::sync::Semaphore::new(32));
                let mut term=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
                loop{tokio::select!{
                    _=&mut stopped=>break,
                    _=term.recv()=>{health.stop();},
                    incoming=listener.accept()=>{
                        let Ok((socket,_))=incoming else{break;};let Ok(permit)=slots.clone().try_acquire_owned()else{continue;};
                        let h=health.clone();let t=telemetry.clone();let auth=token.clone();
                        tokio::spawn(async move{
                            let _permit=permit;
                            let service=service_fn(move|r|handler(r,h.clone(),t.clone(),auth.clone()));
                            let mut builder=http1::Builder::new();builder.keep_alive(false).max_headers(32).max_buf_size(8192).timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(2));
                            let _=tokio::time::timeout(Duration::from_secs(3),builder.serve_connection(TokioIo::new(socket),service)).await;
                        });
                    }
                }}
            });runtime.shutdown_timeout(Duration::from_millis(500));let _=done_tx.send(());
        });Ok(Self{done,stop:Some(stop)})
    }
    pub fn shutdown(mut self){if let Some(stop)=self.stop.take(){let _=stop.send(());}let _=self.done.recv_timeout(Duration::from_secs(1));}
}
async fn handler(req:Request<Incoming>,health:Arc<Health>,telemetry:Arc<Telemetry>,token:String)->Result<Response<Full<Bytes>>,Infallible>{
    let mut content_type="text/plain; charset=utf-8";
    let(status,body)=if req.method()!=hyper::Method::GET {(405,b"method not allowed\n".to_vec())}
    else if req.uri().query().is_some()||req.headers().contains_key("transfer-encoding")||req.headers().get("content-length").is_some_and(|v|v!="0"){(400,b"bad request\n".to_vec())}
    else {match req.uri().path(){
        "/startupz"|"/livez"|"/readyz"=>{let s=health.snapshot();let ok=match req.uri().path(){"/startupz"=>s.startup_complete,"/livez"=>s.live,_=>s.ready};if ok{(200,b"ok\n".to_vec())}else{(503,b"unavailable\n".to_vec())}},
        "/health"=>{if req.headers().get("authorization").and_then(|v|v.to_str().ok())!=Some(&format!("Bearer {token}")){(401,b"unauthorized\n".to_vec())}else{content_type="application/json";match health.json(){Ok(v)=>(200,v),Err(_)=>(503,b"unavailable\n".to_vec())}}},
        "/metrics"=>{content_type="text/plain; version=0.0.4; charset=utf-8";match telemetry.scrape(){Ok(v)=>(200,v),Err(_)=>(503,b"# metrics unavailable\n".to_vec())}},
        _=>(404,b"not found\n".to_vec())
    }};
    Ok(Response::builder().status(status).header("content-type",content_type).header("cache-control","no-store").header("content-length",body.len()).body(Full::new(Bytes::from(body))).unwrap())
}
