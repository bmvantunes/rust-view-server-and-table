#![cfg(not(feature="kafka-canonical"))]
#[path="support/row_delta.rs"] mod row_delta;
#[path="support/durable.rs"] mod support;
use support::*;
use serde_json::{json,Value};
use std::{io::{BufRead,BufReader,Write},process::{Command,Stdio,Child},net::TcpStream,time::{Duration,Instant},fs::OpenOptions};
use tungstenite::{WebSocket,Message,client::IntoClientRequest};
struct Server{child:Child,dir:Directory,address:String,incarnation:String}
impl Server{fn new()->Self{Self::seeded(0)} fn seeded(rows:usize)->Self{
 let dir=Directory::new();let feed=dir.0.join("fixture");std::fs::write(&feed,"").unwrap();
 if rows>0 {use product_source_ingestion::durable::{SqliteStore,DurableStore};let mut store=SqliteStore::create(dir.db(),identity()).unwrap();let(t,_)=store.acquire(0,"seed").unwrap();let records=(0..rows).map(|i|{let mut event=put(0,i as u64,&format!("a-{i:04}"),"-10.01").event;if let rust_differential_product_core::source::ProductMutation::Upsert{row}=&mut event.mutation{row.label=rust_differential_product_core::product::OptionalString::Value("x".repeat(4096));}product_source_ingestion::coordination::Record::new(event)}).collect::<Vec<_>>();store.commit(&t,0,&records).unwrap();store.release(&t).unwrap();}
 let config=json!({"bind":"127.0.0.1:0","origin":"http://127.0.0.1:4173","database":dir.db(),"source":identity(),"expected_partitions":[0],"mode":{"kind":"fixture","path":feed},"run_ms":60000,"stop_file":dir.0.join("stop")});let path=dir.0.join("config.json");std::fs::write(&path,config.to_string()).unwrap();
 let mut child=Command::new(env!("CARGO_BIN_EXE_view_server")).arg(path).env("V12_SESSION_TOKEN","01234567890123456789012345678901").stdout(Stdio::piped()).spawn().unwrap();
 let mut stdout=BufReader::new(child.stdout.take().unwrap());let mut line=String::new();stdout.read_line(&mut line).unwrap();let ready:Value=serde_json::from_str(&line).unwrap();assert_eq!(ready["state"],"ready");
 // Keep draining bounded structured logs so stdout cannot stall the source owner.
 std::thread::spawn(move||{for line in stdout.lines(){match line{Ok(l)=>println!("SERVER {l}"),Err(_)=>break}}});
 Self{child,dir,address:ready["address"].as_str().unwrap().into(),incarnation:ready["incarnation"].as_str().unwrap().into()}
 }
 fn raw(&self,origin:&str)->Result<WebSocket<TcpStream>,tungstenite::HandshakeError<tungstenite::handshake::client::ClientHandshake<TcpStream>>>{
  let mut r=format!("ws://{}/v14",self.address).into_client_request().unwrap();r.headers_mut().insert("origin",origin.parse().unwrap());r.headers_mut().insert("sec-websocket-protocol","view-server.v14.msgpack".parse().unwrap());let stream=TcpStream::connect(&self.address).unwrap();stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();tungstenite::client(r,stream).map(|(s,_)|s)
 }
 fn connect(&self)->(WebSocket<TcpStream>,Value){let mut s=self.raw("http://127.0.0.1:4173").unwrap();s.send(wire(json!({"type":"hello","v":14,"token":"01234567890123456789012345678901","nonce":"01234567890123456789012345678901"}))).unwrap();let r=read(&mut s);assert_eq!(r["type"],"ready");(s,r)}
 fn put(&self,offset:u64,label:&str){let mut r=put(0,offset,"a","-10.01").event;if let rust_differential_product_core::source::ProductMutation::Upsert{row}=&mut r.mutation{row.label=rust_differential_product_core::product::OptionalString::Value(label.into());}let mut f=OpenOptions::new().append(true).open(self.dir.0.join("fixture")).unwrap();writeln!(f,"{}",serde_json::to_string(&r).unwrap()).unwrap();f.flush().unwrap();}
}
impl Drop for Server{fn drop(&mut self){let _=self.child.kill();let _=self.child.wait();}}
fn read(s:&mut WebSocket<TcpStream>)->Value{loop{match s.read().unwrap(){Message::Binary(t)=>return row_delta::reconstruct(v13_codec_experiment::adapt(&v13_codec_experiment::decode_mp(&t).unwrap()).unwrap()),Message::Ping(_)=>{s.flush().unwrap();},m=>panic!("unexpected {m:?}")}}}
fn wire(v:Value)->Message{Message::Binary(v13_codec_experiment::encode_mp(&v13_codec_experiment::prepare(&v).unwrap()).unwrap().into())}
fn command(ready:&Value,id:u64,acquisition:u64,command:Value)->Message{wire(json!({"v":14,"type":"command","incarnation":ready["incarnation"],"connection":ready["connection"],"nonce":ready["nonce"],"request":{"id":id,"acquisition":acquisition,"previous_acquisition":null,"traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","command":command}}))}
fn open()->Value{json!({"command":"open","subscription":"same","query":{"where_expr":{"op":"true"},"direction":"ascending","offset":0,"limit":1}})}
#[test]
fn real_socket_admission_protocol_errors_and_no_duplicate_data_path(){
 let server=Server::new();assert!(server.raw("http://evil.example").is_err());
 let(mut bad,_)=server.connect();bad.send(Message::Text("{".into())).unwrap();assert!(bad.read().is_err());
 let(mut large,_)=server.connect();large.send(Message::Text("x".repeat(65537).into())).unwrap();assert!(large.read().is_err());
 let(mut s,r)=server.connect();assert_eq!(r["incarnation"],server.incarnation);s.send(command(&r,1,1,open())).unwrap();assert_eq!(read(&mut s)["type"],"result");let ack=read(&mut s);assert_eq!(ack["type"],"ack");assert!(ack.get("rows").is_none());assert!(ack.get("result").is_none());
 let mut rejected=open();rejected["command"]=json!("change_query");rejected["query"]["where_expr"]=json!({"op":"invalid"});s.send(command(&r,2,2,rejected)).unwrap();let error=read(&mut s);assert_eq!(error["type"],"request_error");assert_eq!(error["currentAcquisition"],1);
 server.put(0,"after rejection");let live=read(&mut s);assert_eq!(live["type"],"result");assert!(live.get("id").is_none());assert_eq!(live["acquisition"],1);assert_eq!(live["result"]["rows"][0]["label"]["value"],"after rejection");
 // A new conflicting live duplicate must reach durable replay checks and terminate.
 server.put(0,"conflicting duplicate");assert!(s.read().is_err());
}
#[test]
fn stalled_client_does_not_block_healthy_peer_and_is_disconnected(){
 let server=Server::seeded(32);let(mut healthy,h)=server.connect();healthy.send(command(&h,1,1,open())).unwrap();read(&mut healthy);read(&mut healthy);
 let(mut slow,s)=server.connect();let mut large=open();large["query"]["limit"]=json!(32);slow.send(command(&s,1,1,large)).unwrap();
 // Intentionally never read the slow socket until after healthy control settles.
 for id in 2..=100 {let cmd=json!({"command":"change_window","subscription":"same","offset":0,"limit":32});if slow.send(command(&s,id,1,cmd)).is_err(){break;}}
 let start=Instant::now();healthy.send(command(&h,2,1,json!({"command":"change_window","subscription":"same","offset":999,"limit":1}))).unwrap();assert_eq!(read(&mut healthy)["result"]["rows"],json!([]));assert_eq!(read(&mut healthy)["type"],"ack");assert!(start.elapsed()<Duration::from_secs(3));
 let mut disconnected=false;for _ in 0..220{match slow.read(){Ok(_)=>{},Err(_)=>{disconnected=true;break;}}}assert!(disconnected);
 healthy.send(command(&h,3,1,json!({"command":"close","subscription":"same"}))).unwrap();assert_eq!(read(&mut healthy)["result_count"],0);
}

#[test]
fn stalled_socket_isolated_while_peer_receives_eight_exact_live_cuts(){
 let server=Server::seeded(32);let(mut healthy,h)=server.connect();healthy.send(command(&h,1,1,open())).unwrap();read(&mut healthy);read(&mut healthy);
 let(mut slow,s)=server.connect();let mut large=open();large["query"]["limit"]=json!(32);slow.send(command(&s,1,1,large)).unwrap();
 for id in 2..=100{if slow.send(command(&s,id,1,json!({"command":"change_window","subscription":"same","offset":0,"limit":32}))).is_err(){break;}}
 for i in 0..8 {let label=format!("live-{i}");server.put(32+i,&label);let p=read(&mut healthy);assert_eq!(p["type"],"result");assert!(p.get("id").is_none());assert_eq!(p["source_sequence"],(i+2).to_string());assert_eq!(p["acquisition"],1);assert_eq!(p["result"]["start_rank"],0);assert_eq!(p["result"]["total_rows"],33);assert_eq!(p["result"]["rows"][0]["id"],"a");assert_eq!(p["result"]["rows"][0]["label"]["value"],label);assert_eq!(p["result"]["rows"][0]["quantity"],"9223372036854775807");assert_eq!(p["result"]["rows"][0]["amount"],json!({"coefficient":"-1001","scale":2}));}
 let mut disconnected=false;for _ in 0..240{if slow.read().is_err(){disconnected=true;break;}}assert!(disconnected);
 healthy.send(command(&h,2,1,json!({"command":"close","subscription":"same"}))).unwrap();assert_eq!(read(&mut healthy)["type"],"ack");
}

// Inserted only into each isolated candidate's native socket tests.
#[test]
fn malformed_binary_disconnects_acquisition_and_healthy_peer_survives() {
 let server=Server::new();
 for bytes in vec![vec![129,161],vec![193],vec![130,161,97,0,161,97,1],vec![219,255,255,255,255],vec![145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,145,0],vec![199,1,43,0],vec![199,1,42,2],vec![212,42,1],vec![213,42,0,0],vec![161,255]] {
  let(mut bad,ready)=server.connect();
  bad.send(command(&ready,1,1,open())).unwrap();read(&mut bad);read(&mut bad);
  bad.send(Message::Binary(bytes.into())).unwrap();assert!(bad.read().is_err());
 }
 {
  let(mut bad,r)=server.connect();
  bad.send(wire(json!({"v":999,"type":"ping","incarnation":r["incarnation"],"connection":r["connection"],"nonce":r["nonce"]}))).unwrap();
  assert!(bad.read().is_err());
 }
 for kind in ["result","ack"] {
  let(mut bad,r)=server.connect();
  bad.send(wire(json!({"v":14,"type":kind,"incarnation":r["incarnation"],"connection":r["connection"],"nonce":r["nonce"]}))).unwrap();
  assert!(bad.read().is_err());
 }
 let(mut healthy,r)=server.connect();healthy.send(command(&r,1,1,open())).unwrap();read(&mut healthy);read(&mut healthy);
 server.put(0,"after-hostiles");let live=read(&mut healthy);assert_eq!(live["type"],"result");assert_eq!(live["result"]["rows"][0]["label"]["value"],"after-hostiles");
}

#[test] fn projection_excluding_key_rejected_null_and_live_projected_noop(){
 let server=Server::new();let(mut socket,ready)=server.connect();
 let request=|id:u64,acquisition:u64,projection:Value|wire(json!({"v":14,"type":"command","incarnation":ready["incarnation"],"connection":ready["connection"],"nonce":ready["nonce"],"request":{"id":id,"acquisition":acquisition,"previous_acquisition":null,"traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","projection":projection,"command":open()}}));
 socket.send(request(1,1,json!(["quantity"]))).unwrap();let initial=read(&mut socket);assert_eq!(initial["result"]["rows"],json!([]));assert_eq!(read(&mut socket)["type"],"ack");
 server.put(0,"first");let inserted=read(&mut socket);assert_eq!(inserted["result"]["keys"],json!(["a"]));assert_eq!(inserted["result"]["rows"],json!([{"quantity":"9223372036854775807"}]));assert_eq!(inserted["result"]["operations"][0]["type"],"insert");
 socket.send(request(2,2,Value::Null)).unwrap();let rejected=read(&mut socket);assert_eq!(rejected["type"],"request_error");assert_eq!(rejected["currentAcquisition"],1);
 server.put(1,"changed unselected label");let noop=read(&mut socket);assert_eq!(noop["acquisition"],1);assert_eq!(noop["result"]["kind"],"delta");assert_eq!(noop["result"]["operations"],json!([]));assert_eq!(noop["result"]["contentVersion"],inserted["result"]["contentVersion"]);assert_eq!(noop["result"]["revision"].as_u64().unwrap(),inserted["result"]["revision"].as_u64().unwrap()+1);
}
