#[path="support/row_delta.rs"] mod row_delta;
#[path="support/durable.rs"] mod support;
use support::*;
use serde_json::{json,Value};
use std::{io::{BufRead,BufReader,Write},process::{Command,Stdio,Child},net::TcpStream,time::{Duration,Instant}};
use tungstenite::{WebSocket,Message,client::IntoClientRequest};

fn kafka_script()->std::path::PathBuf { std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../scripts/kafka.ts") }
fn run_name()->String { std::env::var("RVS_KAFKA_RUN").expect("RVS_KAFKA_RUN must name an initialized owned run") }
fn owned_run()->Value { let output=Command::new(std::env::var("RVS_NODE").expect("run through VP with the pinned TypeScript-capable Node runtime")).arg(kafka_script()).args(["env","--run",&run_name()]).output().unwrap();assert!(output.status.success(),"{:?}",output);serde_json::from_slice(&output.stdout).unwrap() }
struct Server{child:Child,dir:Directory,address:String,incarnation:String,config:std::path::PathBuf,events:std::sync::Arc<std::sync::Mutex<Vec<Value>>>,reader:Option<std::thread::JoinHandle<()>>}
impl Server{fn new()->Self{Self::seeded(0)} fn seeded(rows:usize)->Self{
 let dir=Directory::new();let state=owned_run();let brokers=state["bootstrapServers"].as_str().unwrap().to_owned();let source=format!("ksq-review-socket-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());let state=format!("{source}-state");
 for (topic,policy) in [(&source,"delete"),(&state,"compact")]{let o=Command::new(std::env::var("RVS_NODE").expect("run through VP with the pinned TypeScript-capable Node runtime")).arg(kafka_script()).args(["topic-create","--run",&run_name(),"--topic",topic,"--cleanup-policy",policy]).output().unwrap();assert!(o.status.success(),"{:?}",o);}
 let config=json!({"bind":"127.0.0.1:0","origin":"http://127.0.0.1:4173","source":{"incarnation":source,"topic":source,"schema":"product-v1"},"expected_partitions":[0,1],"mode":{"kind":"kafka_canonical","config":{"brokers":brokers,"group":format!("{source}-group"),"state_topic":state,"initialize_empty":true,"schemas":{"1":{"schemaType":"PROTOBUF","schema":include_str!("../fixtures/key.proto")},"2":{"schemaType":"PROTOBUF","schema":include_str!("../fixtures/product-v1.proto")}}}},"profile":true,"run_ms":120000,"stop_file":dir.0.join("stop")});let path=dir.0.join("config.json");std::fs::write(&path,config.to_string()).unwrap();
 if rows>0{let mut p=Command::new(std::env::var("RVS_KAFKA_PROBE_BINARY").expect("build current runtime kafka_probe example and set RVS_KAFKA_PROBE_BINARY")).arg("feed").arg(&path).stdin(Stdio::piped()).stdout(Stdio::null()).spawn().unwrap();{let mut input=p.stdin.take().unwrap();for i in 0..rows{writeln!(input,"{}",json!({"id":format!("a-{i:04}"),"partition":0,"quantity":"9223372036854775807","amount":"-10.01","label":"x".repeat(4096)})).unwrap();}}assert!(p.wait().unwrap().success());}
 if let Ok(out)=std::env::var("F1_CONFIG_DIR"){std::fs::create_dir_all(&out).unwrap();std::fs::copy(&path,std::path::Path::new(&out).join(format!("{source}.json"))).unwrap();}
 let mut child=Command::new(std::env::var("RVS_SERVICE_BINARY").expect("build current service and set RVS_SERVICE_BINARY")).arg(&path).env("V12_SESSION_TOKEN","01234567890123456789012345678901").stdout(Stdio::piped()).stderr(Stdio::from(std::fs::File::create(dir.0.join(format!("{source}.stderr.log"))).unwrap())).spawn().unwrap();
 let mut stdout=BufReader::new(child.stdout.take().unwrap());let ready:Value=loop{let mut line=String::new();assert!(stdout.read_line(&mut line).unwrap()>0);let v:Value=serde_json::from_str(&line).unwrap();println!("SERVER {v}");assert_ne!(v["state"],"terminal");if v["state"]=="ready"{break v}};
 let events=std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));let captured=events.clone();let reader=std::thread::spawn(move||{for line in stdout.lines(){match line{Ok(l)=>{println!("SERVER {l}");if let Ok(v)=serde_json::from_str::<Value>(&l){let mut a=captured.lock().unwrap();assert!(a.len()<4096);a.push(v);}},Err(_)=>break}}});
 Self{child,dir,address:ready["address"].as_str().unwrap().into(),incarnation:ready["incarnation"].as_str().unwrap().into(),config:path,events,reader:Some(reader)}
 }
 fn finish(mut self){
  std::fs::write(self.dir.0.join("stop"),"stop").unwrap();let start=Instant::now();
  loop{if let Some(status)=self.child.try_wait().unwrap(){assert!(status.success());break;}assert!(start.elapsed()<Duration::from_secs(20));std::thread::sleep(Duration::from_millis(10));}
  self.reader.take().unwrap().join().unwrap();let events=self.events.lock().unwrap();let stopped=events.iter().find(|v|v["state"]=="stopped").unwrap();assert_eq!(stopped["subscriptions"],0);assert_eq!(stopped["shapes"],0);println!("F1_CLEANUP {stopped}");
 }
 fn raw(&self,origin:&str)->Result<WebSocket<TcpStream>,tungstenite::HandshakeError<tungstenite::handshake::client::ClientHandshake<TcpStream>>>{
  let mut r=format!("ws://{}/v14",self.address).into_client_request().unwrap();r.headers_mut().insert("origin",origin.parse().unwrap());r.headers_mut().insert("sec-websocket-protocol","view-server.v14.msgpack".parse().unwrap());let stream=TcpStream::connect(&self.address).unwrap();stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();tungstenite::client(r,stream).map(|(s,_)|s)
 }
 fn connect(&self)->(WebSocket<TcpStream>,Value){let mut s=self.raw("http://127.0.0.1:4173").unwrap();s.send(wire(json!({"type":"hello","v":14,"token":"01234567890123456789012345678901","nonce":"01234567890123456789012345678901"}))).unwrap();let r=read(&mut s);assert_eq!(r["type"],"ready");(s,r)}
 fn put(&self,_offset:u64,label:&str){let mut p=Command::new(std::env::var("RVS_KAFKA_PROBE_BINARY").expect("build current runtime kafka_probe example and set RVS_KAFKA_PROBE_BINARY")).arg("feed").arg(&self.config).stdin(Stdio::piped()).stdout(Stdio::null()).spawn().unwrap();writeln!(p.stdin.take().unwrap(),"{}",json!({"id":"a","partition":if label=="conflicting duplicate" {1}else{0},"quantity":"9223372036854775807","amount":"-10.01","label":label})).unwrap();assert!(p.wait().unwrap().success());}
}
impl Drop for Server{fn drop(&mut self){let _=self.child.kill();let _=self.child.wait();}}
fn read(s:&mut WebSocket<TcpStream>)->Value{loop{match s.read().unwrap(){Message::Binary(t)=>return row_delta::reconstruct(v13_codec_experiment::adapt(&v13_codec_experiment::decode_mp(&t).unwrap()).unwrap()),Message::Ping(_)|Message::Pong(_)=>{s.flush().unwrap();},m=>panic!("unexpected {m:?}")}}}
fn read_deadline(s:&mut WebSocket<TcpStream>,deadline:Instant,cut:u64)->Value{
 loop{
  let remaining=deadline.checked_duration_since(Instant::now()).unwrap_or(Duration::ZERO);
  assert!(!remaining.is_zero(),"F1 deadline expired at cut {cut}");
  s.get_mut().set_read_timeout(Some(remaining)).unwrap();
  match s.read(){
   Ok(Message::Binary(t))=>{let v=v13_codec_experiment::adapt(&v13_codec_experiment::decode_mp(&t).unwrap()).unwrap();if v["type"]=="pong"{continue;}assert!(Instant::now()<=deadline,"F1 late result cut {cut}");return row_delta::reconstruct(v)},
   Ok(Message::Ping(_)|Message::Pong(_))=>{s.flush().unwrap();},
   result=>panic!("F1 deadline/read failure cut {cut}: {result:?}")
  }
 }
}
fn wire(v:Value)->Message{Message::Binary(v13_codec_experiment::encode_mp(&v13_codec_experiment::prepare(&v).unwrap()).unwrap().into())}
fn command(ready:&Value,id:u64,acquisition:u64,command:Value)->Message{wire(json!({"v":14,"type":"command","incarnation":ready["incarnation"],"connection":ready["connection"],"nonce":ready["nonce"],"request":{"id":id,"acquisition":acquisition,"previous_acquisition":null,"traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","command":command}}))}
fn open()->Value{json!({"command":"open","subscription":"same","query":{"where_expr":{"op":"true"},"direction":"ascending","offset":0,"limit":1}})}
#[test]
#[ignore = "Opt-in owned OrbStack run and current RVS_SERVICE_BINARY/RVS_KAFKA_PROBE_BINARY required"]
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
#[ignore = "Opt-in owned OrbStack run and current RVS_SERVICE_BINARY/RVS_KAFKA_PROBE_BINARY required"]
fn stalled_client_does_not_block_healthy_peer_and_is_disconnected(){
 let server=Server::seeded(32);eprintln!("REVIEW connecting healthy");let(mut healthy,h)=server.connect();eprintln!("REVIEW healthy connected");healthy.send(command(&h,1,1,open())).unwrap();assert_eq!(read(&mut healthy)["type"],"result");assert_eq!(read(&mut healthy)["type"],"ack");
 eprintln!("REVIEW connecting slow");let(mut slow,s)=server.connect();eprintln!("REVIEW slow connected");let mut large=open();large["query"]["limit"]=json!(32);slow.send(command(&s,1,1,large)).unwrap();
 // Intentionally never read the slow socket until after healthy control settles.
 for id in 2..=100 {let cmd=json!({"command":"change_window","subscription":"same","offset":0,"limit":32});if slow.send(command(&s,id,1,cmd)).is_err(){break;}}
 let start=Instant::now();healthy.send(command(&h,2,1,json!({"command":"change_window","subscription":"same","offset":999,"limit":1}))).unwrap();assert_eq!(read(&mut healthy)["result"]["rows"],json!([]));assert_eq!(read(&mut healthy)["type"],"ack");assert!(start.elapsed()<Duration::from_secs(3));
 let mut disconnected=false;for _ in 0..220{match slow.read(){Ok(_)=>{},Err(_)=>{disconnected=true;break;}}}assert!(disconnected);
 healthy.send(command(&h,3,1,json!({"command":"close","subscription":"same"}))).unwrap();assert_eq!(read(&mut healthy)["result_count"],0);
}

#[test]
#[ignore = "Opt-in owned OrbStack run and current RVS_SERVICE_BINARY/RVS_KAFKA_PROBE_BINARY required"]
fn stalled_socket_isolated_while_peer_receives_eight_exact_live_cuts(){schedule("pressure") }
#[test]
#[ignore = "Opt-in owned OrbStack run and current RVS_SERVICE_BINARY/RVS_KAFKA_PROBE_BINARY required"]
fn healthy_only_eight_exact_live_cuts(){schedule("healthy")}
#[test]
#[ignore = "Opt-in owned OrbStack run and current RVS_SERVICE_BINARY/RVS_KAFKA_PROBE_BINARY required"]
fn idle_stalled_peer_eight_exact_live_cuts(){schedule("idle")}
fn schedule(mode:&str){
 let server=Server::seeded(32);eprintln!("REVIEW connecting healthy");let(mut healthy,h)=server.connect();eprintln!("REVIEW healthy connected");healthy.send(command(&h,1,1,open())).unwrap();let initial=read(&mut healthy);assert_eq!(initial["type"],"result");let initial_cut=initial["source_sequence"].as_str().unwrap().parse::<u64>().unwrap();assert_eq!(read(&mut healthy)["type"],"ack");
 let mut slow=if mode!="healthy" {let(mut slow,s)=server.connect();slow.get_mut().set_read_timeout(Some(Duration::from_millis(200))).unwrap();let mut large=open();large["query"]["limit"]=json!(32);slow.send(command(&s,1,1,large)).unwrap();let mut sent=0;
 if mode=="pressure"{for id in 2..=100{if slow.send(command(&s,id,1,json!({"command":"change_window","subscription":"same","offset":0,"limit":32}))).is_err(){break;}sent+=1;}}
 if mode=="pressure"{assert_eq!(sent,99);}
 println!("F1_PRESSURE {}",json!({"mode":mode,"window_commands_sent":sent}));Some(slow)}else{None};
 for i in 0..8 {let label=format!("live-{i}");healthy.send(Message::Ping(Vec::new().into())).unwrap();eprintln!("REVIEW feeding {i}");server.put(32+i,&label);let wait_started=Instant::now();let p=read_deadline(&mut healthy,wait_started+Duration::from_secs(5),i);println!("F1_TIMING {}",json!({"mode":mode,"cut":i,"publication_wait_s":wait_started.elapsed().as_secs_f64(),"deadline_s":5}));assert_eq!(p["type"],"result");assert!(p.get("id").is_none());assert_eq!(p["source_sequence"],(initial_cut+i+1).to_string());assert_eq!(p["acquisition"],1);assert_eq!(p["result"]["start_rank"],0);assert_eq!(p["result"]["total_rows"],33);assert_eq!(p["result"]["rows"][0]["id"],"a");assert_eq!(p["result"]["rows"][0]["label"]["value"],label);assert_eq!(p["result"]["rows"][0]["quantity"],"9223372036854775807");assert_eq!(p["result"]["rows"][0]["amount"],json!({"coefficient":"-1001","scale":2}));}
 if let Some(slow)=slow.as_mut(){let start=Instant::now();let mut last_ping=Instant::now();let mut disconnected=false;
 while start.elapsed()<Duration::from_secs(20){if last_ping.elapsed()>=Duration::from_secs(1){healthy.send(Message::Ping(Vec::new().into())).unwrap();last_ping=Instant::now();}match slow.read(){Ok(Message::Close(_))=>{disconnected=true;break;},Ok(_)=>{},Err(tungstenite::Error::Io(e)) if matches!(e.kind(),std::io::ErrorKind::WouldBlock|std::io::ErrorKind::TimedOut)=>{},Err(_)=>{disconnected=true;break;}}}
 assert!(disconnected,"stalled peer not disconnected by existing policy");println!("F1_PEER {}",json!({"mode":mode,"disconnected":true,"observation_s":start.elapsed().as_secs_f64()}));}
 healthy.send(command(&h,2,1,json!({"command":"close","subscription":"same"}))).unwrap();assert_eq!(read(&mut healthy)["type"],"ack");drop(healthy);server.finish();
}

// Inserted only into each isolated candidate's native socket tests.
#[test]
#[ignore = "Opt-in owned OrbStack run and current RVS_SERVICE_BINARY/RVS_KAFKA_PROBE_BINARY required"]
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
 let(mut healthy,r)=server.connect();healthy.send(command(&r,1,1,open())).unwrap();assert_eq!(read(&mut healthy)["type"],"result");assert_eq!(read(&mut healthy)["type"],"ack");
 server.put(0,"after-hostiles");let live=read(&mut healthy);assert_eq!(live["type"],"result");assert_eq!(live["result"]["rows"][0]["label"]["value"],"after-hostiles");
}
