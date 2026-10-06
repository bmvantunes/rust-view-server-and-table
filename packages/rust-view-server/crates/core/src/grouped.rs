//! Product-owned incremental aggregate multisets. No source scans after admission.
use crate::semantics::{SemanticProfile,sort_token};
use crate::schema::{Schema,Kind,Scalar,Row,valid_name,MAX_KEY_BYTES,path_insert};
use crate::product::ExactDecimal;
use crate::generic::{Direction,Order};
use num_bigint::BigInt;
use num_traits::{One,Signed,ToPrimitive};
use serde::{Serialize,Deserialize};
use serde_json::{Value,json};
use std::collections::{BTreeMap,BTreeSet};

pub const MAX_GROUPS:usize=65_536;
pub const MAX_VALUES:usize=262_144;
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(tag="aggFunc",deny_unknown_fields)]
pub enum Aggregate {
 #[serde(rename="count")] Count,
 #[serde(rename="countDistinct")] CountDistinct{field:String},
 #[serde(rename="sum")] Sum{field:String},
 #[serde(rename="avg")] Avg{field:String},
 #[serde(rename="min")] Min{field:String},
 #[serde(rename="max")] Max{field:String},
}
impl Aggregate {
 fn field(&self)->Option<&str>{match self{Self::Count=>None,Self::CountDistinct{field}|Self::Sum{field}|Self::Avg{field}|Self::Min{field}|Self::Max{field}=>Some(field)}}
 fn name(&self)->&str{match self{Self::Count=>"count",Self::CountDistinct{..}=>"countDistinct",Self::Sum{..}=>"sum",Self::Avg{..}=>"avg",Self::Min{..}=>"min",Self::Max{..}=>"max"}}
}
struct Spec{alias:String,op:Aggregate,field:Option<usize>,kind:Option<Kind>}
#[derive(Default)]
struct Accumulator{contributors:u64,sum:BigInt,values:BTreeMap<String,(Scalar,u64)>}
struct Group{keys:Vec<Scalar>,parents:Vec<String>,count:u64,acc:Vec<Accumulator>,pub row:Value,order:Option<String>}
pub struct Grouped{profile:Option<SemanticProfile>,global:bool,having:Option<crate::generic::Check>,parents:Vec<String>,expanded:bool,topic:String,fingerprint:String,keys:Vec<(usize,String,Kind)>,specs:Vec<Spec>,order:Vec<(String,Direction)>,groups:BTreeMap<String,Group>,entries:usize,pub shape:String,pub projection:Vec<String>,pub error:Option<String>,pub visited:u64}
#[derive(Debug)]
pub struct Change{pub id:String,pub old:Option<String>,pub new:Option<String>}
fn quota(message:&str)->String{format!("aggregate query failed: {message}")}
impl Grouped {
 pub fn new(topic:&str,schema:&Schema,group_by:&[String],aggregates:&BTreeMap<String,Aggregate>,order:&[Order])->Result<Self,String>{
  Self::with_options(topic,schema,group_by,aggregates,order,false,None,None)
 }
 pub fn with_options(topic:&str,schema:&Schema,group_by:&[String],aggregates:&BTreeMap<String,Aggregate>,order:&[Order],global:bool,having:Option<&crate::generic::Predicate>,profile:Option<SemanticProfile>)->Result<Self,String>{
  if (!global&&group_by.is_empty())||(global&&!group_by.is_empty())||group_by.len()>8||aggregates.is_empty()||aggregates.len()>16||order.len()>8{return Err("aggregate shape bounds".into())}
  let mut names=BTreeSet::new();let mut keys=vec![];
  for key in group_by{if !names.insert(key.clone()){return Err("duplicate grouping field".into())}let i=schema.index(key)?;keys.push((i,key.clone(),schema.definition().fields[i].kind));}
  let mut specs=vec![];
  for(alias,op)in aggregates{if !valid_name(alias)||alias=="rowId"||names.iter().any(|n|n.starts_with(&format!("{alias}.")))||!names.insert(alias.clone()){return Err("invalid/colliding aggregate alias".into())}let field=op.field().map(|f|schema.index(f)).transpose()?;let kind=field.map(|i|schema.definition().fields[i].kind);if profile.is_some()&&matches!(op,Aggregate::Sum{..}|Aggregate::Avg{..})&&field.is_some_and(|i|schema.definition().fields[i].nullable){return Err("Effect numeric aggregate requires non-null field".into())}if matches!(op,Aggregate::Sum{..}|Aggregate::Avg{..})&&!matches!(kind,Some(Kind::Number|Kind::Int64|Kind::Uint64|Kind::Decimal)){return Err("sum/avg require numeric field".into())}specs.push(Spec{alias:alias.clone(),op:op.clone(),field,kind});}
  let mut orders=vec![];let mut seen=BTreeSet::new();
  for o in order{let name=match (&o.field,&o.aggregate){(Some(f),None)if group_by.contains(f)=>f,(None,Some(a))if aggregates.contains_key(a)=>a,_=>return Err("group order requires group field or aggregate alias".into())};if !seen.insert(name){return Err("duplicate group ordering".into())}orders.push((name.clone(),o.direction));}
  let mut descriptor=json!([if global{2}else{1},topic,schema.fingerprint(),if global{None}else{Some(group_by)},specs.iter().map(|s|json!([s.alias,s.op.name(),s.op.field()])).collect::<Vec<_>>()]);if let Some(profile)=profile{descriptor.as_array_mut().unwrap().push(json!(profile));}let shape=serde_json::to_string(&descriptor).unwrap();
  let domains=ResultDomains{schema,keys:&keys,specs:&specs,global,profile};
  let having=having.map(|p|crate::generic::compile_profile(&domains,p,0,&mut 0,profile)).transpose()?;
  Ok(Self{profile,global,having,expanded:schema.definition().format==3,parents:schema.definition().expansion.as_ref().map(|e|e.parents.iter().filter(|p|group_by.iter().any(|k|k.starts_with(&format!("{}.",p.path)))).map(|p|p.path.clone()).collect()).unwrap_or_default(),topic:topic.into(),fingerprint:schema.fingerprint().into(),projection:group_by.iter().cloned().chain(aggregates.keys().cloned()).collect(),keys,specs,order:orders,groups:BTreeMap::new(),entries:0,shape,error:None,visited:0})
 }
 fn global_id(&self)->String{let bytes=serde_json::to_vec(&json!([1,self.topic,self.fingerprint])).unwrap();format!("global1:{}",bytes.iter().map(|b|format!("{b:02x}")).collect::<String>())}
 pub fn metrics(&self)->(usize,usize,u64){(self.groups.len(),self.entries,self.visited)}
 pub fn row(&self,id:&str)->&Value{&self.groups[id].row}
 fn identity(&self,row:&Row)->Result<(String,Vec<Scalar>),String>{
  if self.global{return Ok((self.global_id(),vec![]))}
  let keys=self.keys.iter().map(|(i,_,_)|row.cells[*i].clone()).collect::<Vec<_>>();
  let parts=self.keys.iter().zip(&keys).map(|((_,name,kind),v)|{let state=match v{Scalar::Missing=>0,Scalar::Null=>1,_=>2};let value=match v{Scalar::Number(n)=>json!(format!("{:016x}",n.parse::<f64>().unwrap().to_bits())),_=>v.json().unwrap_or(Value::Null)};json!([name,kind,state,value])}).collect::<Vec<_>>();
  let bytes=serde_json::to_vec(&if self.expanded{json!([3,self.topic,self.fingerprint,parts,self.parents.iter().map(|p|json!([p,row.parents.contains(p)])).collect::<Vec<_>>()])}else{json!([1,self.topic,self.fingerprint,parts])}).unwrap();
  if 5+2*bytes.len()>MAX_KEY_BYTES{return Err(quota("group identity byte bound"))}
  Ok((format!("gid1:{}",bytes.iter().map(|b|format!("{b:02x}")).collect::<String>()),keys))
 }
 /// Retractions precede additions. Only touched groups are finalized and ranked.
 pub fn update<'a>(&mut self,rows:impl IntoIterator<Item=(&'a Row,i8)>)->Result<Vec<Change>,String>{
  let mut touched=BTreeMap::new();
  if self.global{let id=self.global_id();let g=self.groups.entry(id.clone()).or_insert_with(||Group{keys:vec![],parents:vec![],count:0,acc:(0..self.specs.len()).map(|_|Accumulator::default()).collect(),row:Value::Null,order:None});touched.insert(id,g.order.clone());}
  for(row,weight)in rows{self.visited+=1;let(id,keys)=self.identity(row)?;
   if !self.groups.contains_key(&id){if weight<0{return Err(quota("missing retraction group"))}if self.groups.len()>=MAX_GROUPS{return Err(quota("group bound"))}self.groups.insert(id.clone(),Group{keys,parents:self.parents.iter().filter(|p|row.parents.contains(*p)).cloned().collect(),count:0,acc:(0..self.specs.len()).map(|_|Accumulator::default()).collect(),row:Value::Null,order:None});}
   let g=self.groups.get_mut(&id).unwrap();touched.entry(id).or_insert_with(||g.order.clone());
   g.count=if weight>0{g.count.checked_add(1)}else{g.count.checked_sub(1)}.ok_or_else(||quota("count range"))?;
   for(s,a)in self.specs.iter().zip(&mut g.acc){let Some(i)=s.field else{continue};let value=&row.cells[i];let contributes=!matches!(value,Scalar::Missing|Scalar::Null);
    if matches!(s.op,Aggregate::CountDistinct{..})||(contributes||self.profile.is_some())&&matches!(s.op,Aggregate::Min{..}|Aggregate::Max{..}){
     let key=sort_token(value,self.profile,true);if weight>0{if !a.values.contains_key(&key){if self.entries>=MAX_VALUES{return Err(quota("retained multiset entry bound"))}self.entries+=1;}let entry=a.values.entry(key).or_insert_with(||(value.clone(),0));entry.1=entry.1.checked_add(1).ok_or_else(||quota("multiplicity range"))?;}
     else{let entry=a.values.get_mut(&key).ok_or_else(||quota("missing multiset retraction"))?;entry.1=entry.1.checked_sub(1).ok_or_else(||quota("negative multiplicity"))?;if entry.1==0{a.values.remove(&key);self.entries-=1;}}
    }
    if contributes&&matches!(s.op,Aggregate::Sum{..}|Aggregate::Avg{..}){a.contributors=if weight>0{a.contributors.checked_add(1)}else{a.contributors.checked_sub(1)}.ok_or_else(||quota("contributor count"))?;let units=if self.profile.is_some()&&s.kind==Some(Kind::Number){effect_number_units(value)}else{units(value)};a.sum+=units*weight;if s.kind==Some(Kind::Number){if a.sum.bits()>2200{return Err(quota("binary accumulator bound"))}}else if s.kind==Some(Kind::Decimal){if a.sum.abs().to_string().len()>512{return Err(quota("decimal accumulator bound"))}}else if a.sum < -(BigInt::one()<<255usize)||a.sum >= (BigInt::one()<<255usize){return Err(quota("integer accumulator bound"))}}
   }
  }
  let mut changes=vec![];
  for(id,old)in touched{let g=self.groups.get_mut(&id).unwrap();if g.count==0&&!self.global{self.groups.remove(&id);changes.push(Change{id,old,new:None});continue}
   let mut row=serde_json::Map::new();for p in &g.parents{path_insert(&mut row,p,Value::Object(serde_json::Map::new()));}let mut tokens=BTreeMap::new();let mut cells=g.keys.clone();
   for((_,name,_),v)in self.keys.iter().zip(&g.keys){if let Some(value)=v.json(){path_insert(&mut row,name,value);}tokens.insert(name.clone(),sort_token(v,self.profile,false));}
   for(s,a)in self.specs.iter().zip(&g.acc){let value=finalize(s,a,g.count,self.profile)?;tokens.insert(s.alias.clone(),sort_token(&value,self.profile,false));cells.push(value.clone());if let Some(value)=value.json(){row.insert(s.alias.clone(),value);}}
   let mut order=String::new();for(name,direction)in &self.order{crate::generic::append_order(&mut order,&tokens[name],*direction);}
   g.row=Value::Object(row);if serde_json::to_vec(&g.row).unwrap().len()>65_536{return Err(quota("group row byte bound"))}let admitted=self.having.as_ref().is_none_or(|h|h.matches(&Row{key:id.clone(),cells,parents:BTreeSet::new()}));g.order=admitted.then_some(order);changes.push(Change{id,old,new:g.order.clone()});
  }
  Ok(changes)
 }
}
fn units(value:&Scalar)->BigInt{match value{
 Scalar::Int64(n)=>BigInt::from(*n),Scalar::Uint64(n)=>BigInt::from(*n),
 Scalar::Decimal(n)=>{let text=n.to_string_exact();let (whole,fraction)=text.split_once('.').unwrap_or((&text,""));format!("{whole}{fraction}{}","0".repeat(128-fraction.len())).parse().unwrap()},
 Scalar::Number(n)=>{let bits=n.parse::<f64>().unwrap().to_bits();let exponent=((bits>>52)&2047)as usize;let mantissa=bits&((1u64<<52)-1);let mut v=BigInt::from(if exponent==0{mantissa}else{mantissa|(1<<52)})<<exponent.saturating_sub(1);if bits>>63!=0{v=-v}v},_=>unreachable!()}}
fn rounded(n:&BigInt,d:&BigInt)->BigInt{let sign=n.sign();let n=n.abs();let q=&n/d;let r=&n%d;let cmp=(&r*2u8).cmp(d);let q=if cmp.is_gt()||cmp.is_eq()&&(&q%2u8)==BigInt::one(){q+1u8}else{q};if sign==num_bigint::Sign::Minus{-q}else{q}}
fn decimal(n:BigInt,scale:usize)->Scalar{let negative=n.is_negative();let mut digits=n.abs().to_string();if scale>0{if digits.len()<=scale{digits=format!("{}{}","0".repeat(scale+1-digits.len()),digits);}digits.insert(digits.len()-scale,'.');while digits.ends_with('0'){digits.pop();}if digits.ends_with('.'){digits.pop();}}if negative&&digits!="0"{digits.insert(0,'-');}Scalar::Decimal(ExactDecimal::parse(&digits).unwrap())}
/// Exact integer binary units divided by d, rounded once to nearest/even binary64.
fn binary(n:&BigInt,d:u64)->Result<Scalar,String>{
 let negative=n.is_negative();let abs=n.abs();let den=BigInt::from(d);let quotient=&abs/&den;
 let mut shift=quotient.bits().saturating_sub(53)as usize;
 let mut significand=rounded(&abs,&(&den<<shift));
 if significand.bits()>53{shift+=1;significand=rounded(&abs,&(&den<<shift));}
 let sig=significand.to_u64().ok_or_else(||quota("binary finalization"))?;
 let exponent=if sig<(1<<52){0}else{shift+1};if exponent>=2047{return Err(quota("binary64 result overflow"))}
 let bits=if sig==0{0}else{((negative as u64)<<63)|((exponent as u64)<<52)|(sig&((1<<52)-1))};
 Ok(Scalar::Number(f64::from_bits(bits).to_string()))
}
fn finalize(s:&Spec,a:&Accumulator,count:u64,profile:Option<SemanticProfile>)->Result<Scalar,String>{Ok(match &s.op{
 Aggregate::Count=>decimal(BigInt::from(count),0),Aggregate::CountDistinct{..}=>decimal(BigInt::from(a.values.len()),0),
 Aggregate::Min{..}=>a.values.first_key_value().map(|(_,v)|v.0.clone()).unwrap_or(Scalar::Null),
 Aggregate::Max{..}=>a.values.last_key_value().map(|(_,v)|v.0.clone()).unwrap_or(Scalar::Null),
 Aggregate::Sum{..}|Aggregate::Avg{..}=>{let avg=matches!(s.op,Aggregate::Avg{..});if avg&&a.contributors==0{if profile.is_some(){decimal(BigInt::from(0),0)}else{Scalar::Null}}else if profile.is_some(){let scale=if s.kind==Some(Kind::Number){324}else if s.kind==Some(Kind::Decimal){128}else{0};if avg{effect_average(&a.sum,a.contributors,scale)?}else{decimal(a.sum.clone(),scale)}}else if s.kind==Some(Kind::Number){binary(&a.sum,if avg{a.contributors}else{1})?}else if avg{let scale=if s.kind==Some(Kind::Decimal){128}else{0};let n=&a.sum*BigInt::from(10u8).pow(18);let d=BigInt::from(a.contributors)*BigInt::from(10u8).pow(scale);decimal(rounded(&n,&d),18)}else{decimal(a.sum.clone(),if s.kind==Some(Kind::Decimal){128}else{0})}}
})}

#[cfg(test)]mod tests{
 use super::*;
 #[test]fn rounding_ties_overflow_and_reversible_binary(){
  for(n,d,expected)in [("1","2","0"),("3","2","2"),("5","2","2"),("-3","2","-2")]{assert_eq!(rounded(&n.parse().unwrap(),&d.parse().unwrap()).to_string(),expected);}
  let a=units(&Scalar::Number("10000000000000000".into()));let one=units(&Scalar::Number("1".into()));assert_eq!(binary(&(&a+&one-&a),1).unwrap().json(),Some(json!(1.0)));
  let max=units(&Scalar::Number(f64::MAX.to_string()));assert!(binary(&(&max*2),1).is_err());assert_eq!(binary(&max,1).unwrap().json(),Some(json!(f64::MAX)));
  assert_eq!(binary(&BigInt::from(1),2).unwrap().json(),Some(json!(0.0)));assert_eq!(binary(&BigInt::from(3),2).unwrap().json(),Some(json!(f64::from_bits(2))));
 }
 #[test]fn checked_identity_and_retained_value_bounds(){
  let schema=Schema::new(serde_json::from_value(json!({"format":1,"id":"test","version":1,"key":"id","fields":[{"name":"id","kind":"string","optional":false,"nullable":false},{"name":"v","kind":"string","optional":false,"nullable":false}]})).unwrap()).unwrap();
  let aggs=BTreeMap::from([("d".into(),Aggregate::CountDistinct{field:"v".into()})]);let mut g=Grouped::new("test",&schema,&["id".into()],&aggs,&[]).unwrap();let row=schema.row(&json!({"id":"x","v":"value"})).unwrap();g.entries=MAX_VALUES;assert!(g.update([(&row,1)]).unwrap_err().contains("retained multiset"));
  let row=schema.row(&json!({"id":"x".repeat(250),"v":"value"})).unwrap();assert!(g.identity(&row).unwrap_err().contains("identity"));
 }
}

/// HAVING uses exact aggregate result domains, not narrowed source operands.
struct ResultDomains<'a>{profile:Option<SemanticProfile>,schema:&'a Schema,keys:&'a [(usize,String,Kind)],specs:&'a [Spec],global:bool}
impl crate::generic::PredicateSchema for ResultDomains<'_>{
 fn index(&self,name:&str)->Result<usize,String>{self.keys.iter().map(|(_,n,_)|n).chain(self.specs.iter().map(|s|&s.alias)).position(|n|n==name).ok_or_else(||"HAVING field unavailable in aggregate result".into())}
 fn field(&self,i:usize)->crate::schema::Field{
  if i<self.keys.len(){return self.schema.definition().fields[self.keys[i].0].clone()}
  let s=&self.specs[i-self.keys.len()];let source=s.field.map(|j|&self.schema.definition().fields[j]);
  let kind=match s.op{Aggregate::Count|Aggregate::CountDistinct{..}=>Kind::Decimal,Aggregate::Sum{..}|Aggregate::Avg{..}=>if s.kind==Some(Kind::Number)&&self.profile.is_none(){Kind::Number}else{Kind::Decimal},_=>s.kind.unwrap()};
  crate::schema::Field{name:s.alias.clone(),kind,optional:false,nullable:matches!(s.op,Aggregate::Avg{..}|Aggregate::Min{..}|Aggregate::Max{..})&&(self.global||source.is_some_and(|f|f.optional||f.nullable))}
 }
 fn scalar(&self,i:usize,v:&Value)->Result<Scalar,String>{
  if i<self.keys.len(){return self.schema.scalar(self.keys[i].0,v)}
  let s=&self.specs[i-self.keys.len()];
  if matches!(s.op,Aggregate::Min{..}|Aggregate::Max{..}){return self.schema.scalar(s.field.unwrap(),v)}
  if self.profile.is_none()&&s.kind==Some(Kind::Number)&&matches!(s.op,Aggregate::Sum{..}|Aggregate::Avg{..}){return v.as_f64().filter(|n|n.is_finite()).map(|n|Scalar::Number(if n==0.0{"0".into()}else{n.to_string()})).ok_or_else(||"HAVING finite numeric operand required".into())}
  let text=v.as_str().ok_or("HAVING exact aggregate operand must be a string")?;
  let max_scale=if self.profile.is_some(){424}else if matches!(s.op,Aggregate::Avg{..}){18}else if matches!(s.op,Aggregate::Sum{..})&&s.kind==Some(Kind::Decimal){128}else{0};
  if text.len()>514||text.split_once('.').is_some_and(|(_,f)|f.len()>max_scale){return Err("HAVING aggregate operand bound".into())}
  let value=ExactDecimal::parse(text)?;if value.to_string_exact()!=text{return Err("HAVING canonical aggregate operand required".into())}
  if matches!(s.op,Aggregate::Count|Aggregate::CountDistinct{..}){text.parse::<u64>().map_err(|_|"HAVING count range")?;}
  if matches!(s.op,Aggregate::Sum{..})&&matches!(s.kind,Some(Kind::Int64|Kind::Uint64)){let n=text.parse::<BigInt>().map_err(|_|"HAVING integer operand")?;if n < -(BigInt::one()<<255usize)||n >= (BigInt::one()<<255usize){return Err("HAVING integer256 range".into())}}
  Ok(Scalar::Decimal(value))
 }
}

fn effect_number_units(value:&Scalar)->BigInt {
 let Scalar::Number(value)=value else{unreachable!()};
 let mut buffer=ryu_js::Buffer::new();
 let text=buffer.format(value.parse::<f64>().unwrap());
 let (mantissa,exponent)=text.split_once('e').map_or((text,0),|(m,e)|(m,e.parse::<i32>().unwrap()));
 let (whole,fraction)=mantissa.split_once('.').unwrap_or((mantissa,""));
 let coefficient:BigInt=format!("{whole}{fraction}").parse().unwrap();
 coefficient*BigInt::from(10u8).pow((324+exponent-fraction.len()as i32)as u32)
}
fn effect_average(sum:&BigInt,count:u64,scale:usize)->Result<Scalar,String> {
 use num_traits::Zero;
 if sum.is_zero(){return Ok(decimal(BigInt::from(0),0))}
 let denominator=BigInt::from(count)*BigInt::from(10u8).pow(scale as u32);
 let absolute=sum.abs();
 let mut exponent=absolute.to_string().len()as i32-denominator.to_string().len()as i32;
 let below=if exponent>=0{absolute<(&denominator*BigInt::from(10u8).pow(exponent as u32))}else{(&absolute*BigInt::from(10u8).pow((-exponent)as u32))<denominator};
 if below{exponent-=1;}
 let target_scale=99-exponent;
 let (numerator,divisor)=if target_scale>=0{(&absolute*BigInt::from(10u8).pow(target_scale as u32),denominator)}else{(absolute,denominator*BigInt::from(10u8).pow((-target_scale)as u32))};
 let mut quotient=&numerator/&divisor;
 if (&numerator%&divisor)*2u8>=divisor{quotient+=1u8;}
 if sum.is_negative(){quotient=-quotient;}
 Ok(Scalar::Decimal(ExactDecimal::new(crate::product::ExactInteger::parse(quotient.to_string())?,target_scale)?))
}
