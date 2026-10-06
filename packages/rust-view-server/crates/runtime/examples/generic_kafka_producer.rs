//! Persistent qualification producer. One client, line-oriented commands/ACKs.
#[cfg(feature="kafka-canonical")]
fn main()->Result<(),Box<dyn std::error::Error>>{
 use product_source_ingestion::{generic_kafka::SourceConfig,generic_source::Decoder};
 use rust_differential_product_core::schema::{Catalog,Manifest,Kind};
 use rdkafka::{ClientConfig,ClientContext,Message,producer::{BaseProducer,BaseRecord,Producer,ProducerContext,DeliveryResult}};
 use std::{io::{BufRead,Write},sync::{Arc,Mutex},time::{Duration,Instant}};
 use serde_json::{Value,json};
 #[derive(Clone)]struct Context(Arc<Mutex<Option<Result<(i32,i64),String>>>>);impl ClientContext for Context{}impl ProducerContext for Context{type DeliveryOpaque=();fn delivery(&self,r:&DeliveryResult,_:()){let mut slot=self.0.lock().unwrap();assert!(slot.is_none());*slot=Some(r.as_ref().map(|m|(m.partition(),m.offset())).map_err(|(e,_)|e.to_string()));}}
 fn varint(mut n:u64,v:&mut Vec<u8>){while n>127{v.push((n as u8&127)|128);n>>=7;}v.push(n as u8);}
 fn string(tag:u32,s:&str,v:&mut Vec<u8>){varint((tag as u64)<<3|2,v);varint(s.len()as u64,v);v.extend(s.as_bytes());}
 fn frame(id:u32,index:u32,body:Vec<u8>)->Vec<u8>{let mut v=vec![0];v.extend(id.to_be_bytes());if index==0{v.push(0);}else{v.push(2);varint((index as u64)<<1,&mut v);}v.extend(body);v}
 fn scalar(tag:u32,kind:Kind,value:&Value,out:&mut Vec<u8>)->Result<(),Box<dyn std::error::Error>> {
  match kind {Kind::Enum=>return Err("expanded producer uses raw protobuf bytes".into()),Kind::String|Kind::Decimal=>string(tag,value.as_str().ok_or("string scalar")?,out),Kind::Boolean=>{varint((tag as u64)<<3,out);out.push(u8::from(value.as_bool().ok_or("bool scalar")?));},Kind::Number=>{varint((tag as u64)<<3|1,out);out.extend(value.as_f64().ok_or("number scalar")?.to_le_bytes());},Kind::Int64=>{varint((tag as u64)<<3,out);varint(value.as_str().ok_or("int64 scalar")?.parse::<i64>()? as u64,out);},Kind::Uint64=>{varint((tag as u64)<<3,out);varint(value.as_str().ok_or("uint64 scalar")?.parse::<u64>()?,out);}}Ok(())
 }
 fn hex(raw:&str)->Result<Vec<u8>,Box<dyn std::error::Error>> {if raw.len()%2!=0||!raw.bytes().all(|b|b.is_ascii_hexdigit()){return Err("raw hex".into());}Ok((0..raw.len()).step_by(2).map(|i|u8::from_str_radix(&raw[i..i+2],16)).collect::<Result<Vec<_>,_>>()?)}
 let args=std::env::args().collect::<Vec<_>>();let c:Value=serde_json::from_slice(&std::fs::read(&args[1])?)?;let configs:Vec<SourceConfig>=serde_json::from_value(c["sources"].clone())?;let catalog=Catalog::new(serde_json::from_value::<Manifest>(c["catalog"].clone())?)?;
 let brokers=&configs[0].brokers;if !brokers.starts_with("127.0.0.1:")||configs.iter().any(|s|s.brokers!=*brokers){return Err("qualification producer requires one loopback broker".into());}
 let context=Context(Arc::new(Mutex::new(None)));let mut cfg=ClientConfig::new();cfg.set("bootstrap.servers",brokers).set("enable.idempotence","true").set("acks","all");let transactional=args.get(2).is_some_and(|v|v=="transactions");if transactional{cfg.set("transactional.id",format!("generic-qualification-source-{}",std::process::id()));}
 let producer:BaseProducer<Context>=cfg.create_with_context(context.clone())?;if transactional{producer.init_transactions(Duration::from_secs(10))?;}
 println!("{{\"producer_ready\":true}}");std::io::stdout().flush()?;
 for line in std::io::stdin().lock().lines(){let started=Instant::now();let v:Value=serde_json::from_str(&line?)?;
  if let Some(op)=v["op"].as_str(){match op{"begin"=>producer.begin_transaction()?,"commit"=>producer.commit_transaction(Duration::from_secs(10))?,"abort"=>producer.abort_transaction(Duration::from_secs(10))?,_=>return Err("unknown producer transaction command".into())};println!("{}",json!({"ack":v["ack"],"op":op}));std::io::stdout().flush()?;continue;}
  let source=configs.iter().find(|s|Some(s.topic.as_str())==v["topic"].as_str()).ok_or("unknown topic")?;let schema=catalog.schema(&source.topic,&source.schema)?;let delete=v["delete"]==true;
  let mut key=if schema.definition().format>=2 {String::new()}else if delete{v["key"].as_str().ok_or("delete key")?.to_owned()}else{schema.row(&v["row"])?.key};let partition=v["partition"].as_u64().filter(|p|source.partitions.contains(&(*p as u32))).ok_or("partition")?;
  let mut key_bytes=Vec::new();if schema.definition().format>=2 {if v.get("raw_key_hex").is_none(){for f in &source.key_fields {scalar(f.tag,f.kind,v["key"].get(&f.name).ok_or("missing fixture key field")?,&mut key_bytes)?;}}}else{string(source.key_tag,&key,&mut key_bytes);}
  let key_bytes=if let Some(raw)=v["raw_key_hex"].as_str(){hex(raw)?}else{frame(source.key_descriptor.schema_id,source.key_descriptor.message_index,key_bytes)};let mut body=Vec::new();
  if !delete {for m in &source.mapping{let f=schema.field(&m.field)?;let Some(value)=v["row"].get(&m.field)else{continue};if value.is_null(){let tag=m.null_tag.ok_or("null marker")?;varint((tag as u64)<<3,&mut body);body.push(1);continue;}
    scalar(m.tag,f.kind,value,&mut body)?;
  }}
  let payload=if let Some(raw)=v["raw_value_hex"].as_str(){hex(raw)?}else{frame(source.value_descriptor.schema_id,source.value_descriptor.message_index,body)};
  if schema.definition().format>=2 {
   if v.get("raw_key_hex").is_none()&&v.get("raw_value_hex").is_none(){
    let d=Decoder::new_identity(schema.clone(),&source.key_descriptor,&source.value_descriptor,source.mapping.clone(),source.key_fields.clone(),source.identity.clone().ok_or("v2 identity")?)?;
    key=d.decode(Some(&key_bytes),if delete{None}else{Some(&payload)})?.0;
   }else{key="raw-unvalidated".into();}
  }

  let record=BaseRecord::<Vec<u8>,Vec<u8>>::to(&source.source_topic).partition(partition as i32).key(&key_bytes);let record=if delete{record}else{record.payload(&payload)};let record=if let Some(ms)=v["timestamp_ms"].as_i64(){record.timestamp(ms)}else{record};producer.send(record).map_err(|(e,_)|e)?;
  let enqueued=started.elapsed();let delivered=loop{producer.poll(Duration::from_millis(1));if let Some(r)=context.0.lock().unwrap().take(){break r?;}if started.elapsed()>Duration::from_secs(10){return Err("producer delivery deadline".into());}};
  println!("{}",json!({"ack":v["ack"],"topic":source.topic,"key":key,"partition":delivered.0,"offset":delivered.1,"timestamp_ms":v["timestamp_ms"],"bytes":key_bytes.len()+if delete{0}else{payload.len()},"enqueue_us":enqueued.as_micros(),"delivery_us":started.elapsed().as_micros()}));std::io::stdout().flush()?;
 }
 producer.flush(Duration::from_secs(10))?;Ok(())
}
#[cfg(not(feature="kafka-canonical"))]fn main(){panic!("requires kafka-canonical")}
