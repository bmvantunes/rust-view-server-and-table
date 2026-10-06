//! Immutable flat scalar schemas. No source credentials or runtime mutation.
use crate::product::ExactDecimal;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_FIELDS: usize = 64;
pub const MAX_TOPICS: usize = 16;
pub const MAX_ROW_BYTES: usize = 65_536;
pub const MAX_STRING_BYTES: usize = 4_096;
pub const MAX_KEY_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Kind { String, Boolean, Number, Int64, Uint64, Decimal, Enum }
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field { pub name:String, pub kind:Kind, pub optional:bool, pub nullable:bool }
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Definition { pub format:u32, pub id:String, pub version:u32, pub key:String, pub fields:Vec<Field>, #[serde(default,skip_serializing_if="Option::is_none")] pub expansion:Option<Expansion> }
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Parent {pub path:String,pub message:String,pub required:bool}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Leaf {pub path:String,pub presence:String,pub required:bool,#[serde(default,skip_serializing_if="Option::is_none")]pub enum_domain:Option<String>}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expansion {pub message:String,pub parents:Vec<Parent>,pub leaves:Vec<Leaf>,pub enums:BTreeMap<String,BTreeMap<String,i32>>}
pub fn valid_path(path:&str)->bool {path.len()<=512&&path.split('.').count()<=8&&path.split('.').all(|p|valid_name(p)&&p!="rowId")}
pub fn path_get<'a>(value:&'a Value,path:&str)->Option<&'a Value>{let mut v=value;for p in path.split('.'){v=v.as_object()?.get(p)?;}Some(v)}
pub fn path_insert(object:&mut Map<String,Value>,path:&str,value:Value){if let Some((first,rest))=path.split_once('.') {let child=object.entry(first.to_owned()).or_insert_with(||Value::Object(Map::new()));path_insert(child.as_object_mut().expect("admitted disjoint scalar paths"),rest,value);}else{object.insert(path.into(),value);}}
#[derive(Clone, Debug)]
pub struct Schema { definition:Definition, fingerprint:String, fields:BTreeMap<String,usize> }
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Scalar { Missing, Null, String(String), Boolean(bool), Number(String), Int64(i64), Uint64(u64), Decimal(ExactDecimal), Enum(String,i32) }
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Row { pub key:String, pub cells:Vec<Scalar>, pub parents:BTreeSet<String> }

pub fn valid_name(value:&str)->bool {
    !value.is_empty() && value.len()<=64 && value.as_bytes()[0].is_ascii_alphabetic()
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b==b'_')
        && !matches!(value,"__proto__"|"prototype"|"constructor")
}
pub fn valid_key(value:&str)->bool { !value.is_empty() && value.len()<=MAX_KEY_BYTES && !value.chars().any(char::is_control) }
impl Schema {
    pub fn new(definition:Definition)->Result<Self,String> {
        if !matches!((definition.format,definition.version),(1,1)|(2,2)|(3,3)) || !valid_name(&definition.id) || !valid_name(&definition.key)
            || definition.fields.is_empty() || definition.fields.len()>MAX_FIELDS {return Err("invalid flat schema header or field bound".into());}
        let mut fields=BTreeMap::new();
        for (i,f) in definition.fields.iter().enumerate() {
            if !(if definition.format==3 {valid_path(&f.name)}else{valid_name(&f.name)}) || f.name=="rowId" || fields.insert(f.name.clone(),i).is_some(){return Err("invalid or duplicate schema field".into());}
        }
        if definition.format>=2 {
            if definition.key!="rowId" {return Err("schema v2 key must be reserved rowId metadata".into());}
        } else {
            let key=fields.get(&definition.key).ok_or("schema key is not a field")?;
            let f=&definition.fields[*key];
            if f.kind!=Kind::String || f.optional || f.nullable {return Err("row key must be a required non-null string".into());}
        }
        if definition.format==3 {
            let e=definition.expansion.as_ref().ok_or("expansion metadata required")?;
            if !valid_path(&e.message)||e.parents.len()>64||e.leaves.len()!=definition.fields.len()||e.enums.len()>64{return Err("expansion bounds".into())}
            let mut parents=BTreeSet::new();
            for p in &e.parents {if !valid_path(&p.path)||!valid_path(&p.message)||fields.contains_key(&p.path)||!parents.insert(p.path.clone()){return Err("invalid parent path".into())}}
            for p in &e.parents {if let Some((ancestor,_))=p.path.rsplit_once('.') {if !parents.contains(ancestor){return Err("missing parent metadata".into())}}}
            for (f,l) in definition.fields.iter().zip(&e.leaves) {
                if f.name!=l.path||!matches!(l.presence.as_str(),"explicit"|"implicit")||l.presence=="implicit"&&(!l.required||f.nullable||f.kind==Kind::Decimal){return Err("invalid leaf presence".into())}
                let mut prefix=l.path.as_str();let mut optional=!l.required;
                while let Some((ancestor,_))=prefix.rsplit_once('.') {let p=e.parents.iter().find(|p|p.path==ancestor).ok_or("missing leaf parent")?;optional|=!p.required;prefix=ancestor;}
                if f.optional!=optional{return Err("effective optionality mismatch".into())}
                if f.kind==Kind::Enum {if !l.enum_domain.as_ref().is_some_and(|d|e.enums.contains_key(d)){return Err("missing enum domain".into())}}else if l.enum_domain.is_some(){return Err("enum domain on non-enum".into())}
            }
            for (domain,labels) in &e.enums {if !valid_path(domain)||labels.is_empty()||labels.len()>256||!labels.values().any(|v|*v==0)||labels.keys().any(|k|!valid_name(k)){return Err("invalid enum domain".into())}}
        }else if definition.expansion.is_some()||definition.fields.iter().any(|f|f.kind==Kind::Enum){return Err("expansion requires version 3".into())}
        let fingerprint=format!("{:x}",Sha256::digest(serde_json::to_vec(&definition).map_err(|e|e.to_string())?));
        Ok(Self{definition,fingerprint,fields})
    }
    pub fn valid_identity(&self,key:&str)->bool {if self.definition.format>=2 {valid_row_id(key)}else{valid_key(key)}}
    pub fn definition(&self)->&Definition {&self.definition}
    pub fn fingerprint(&self)->&str {&self.fingerprint}
    pub fn index(&self,name:&str)->Result<usize,String> {self.fields.get(name).copied().ok_or_else(||format!("unknown schema field: {name}"))}
    pub fn field(&self,name:&str)->Result<&Field,String> {Ok(&self.definition.fields[self.index(name)?])}
    pub fn scalar(&self,index:usize,value:&Value)->Result<Scalar,String> {
        let f=self.definition.fields.get(index).ok_or("invalid field index")?;
        if value.is_null() {return if f.nullable {Ok(Scalar::Null)} else {Err(format!("{} is not nullable",f.name))};}
        let wrong=||format!("invalid {} scalar or value bound",f.name);
        match f.kind {
            Kind::Enum=>{let o=value.as_object().ok_or_else(wrong)?;let domain=self.definition.expansion.as_ref().and_then(|e|e.leaves[index].enum_domain.as_ref()).ok_or_else(wrong)?;let code=o.get("code").and_then(Value::as_i64).and_then(|v|i32::try_from(v).ok()).ok_or_else(wrong)?;if o.len()!=2||o.get("domain").and_then(Value::as_str)!=Some(domain){return Err(wrong())}Ok(Scalar::Enum(domain.clone(),code))},
            Kind::String=>value.as_str().filter(|s|s.len()<=MAX_STRING_BYTES).map(|s|Scalar::String(s.into())).ok_or_else(wrong),
            Kind::Boolean=>value.as_bool().map(Scalar::Boolean).ok_or_else(wrong),
            Kind::Number=>value.as_f64().filter(|v|v.is_finite()).map(|v|Scalar::Number(if v==0.0 {"0".into()}else{v.to_string()})).ok_or_else(wrong),
            Kind::Int64=>{let s=value.as_str().ok_or_else(wrong)?;let n=s.parse::<i64>().map_err(|_|wrong())?;if n.to_string()!=s{return Err(wrong());}Ok(Scalar::Int64(n))},
            Kind::Uint64=>{let s=value.as_str().ok_or_else(wrong)?;let n=s.parse::<u64>().map_err(|_|wrong())?;if n.to_string()!=s{return Err(wrong());}Ok(Scalar::Uint64(n))},
            Kind::Decimal=>{let s=value.as_str().filter(|s|s.len()<=256).ok_or_else(wrong)?;let n=ExactDecimal::parse(s)?;if s.split('.').nth(1).is_some_and(|f|f.len()>128) || n.to_string_exact().len()>256 || n.to_string_exact()!=s{return Err(wrong());}Ok(Scalar::Decimal(n))}
        }
    }
    pub fn row(&self,value:&Value)->Result<Row,String> {
        if serde_json::to_vec(value).map_err(|e|e.to_string())?.len()>MAX_ROW_BYTES{return Err("row byte bound".into());}
        let object=value.as_object().ok_or("row must be an object")?;
        let mut parents=BTreeSet::new();
        if let Some(e)=&self.definition.expansion {
            fn inspect(value:&Value,prefix:&str,fields:&BTreeMap<String,usize>,e:&Expansion)->Result<(),String>{
                for (key,v) in value.as_object().ok_or("parent must be an object")? {if prefix.is_empty()&&key=="rowId"{continue}let path=if prefix.is_empty(){key.clone()}else{format!("{prefix}.{key}")};if e.parents.iter().any(|p|p.path==path){inspect(v,&path,fields,e)?}else if !fields.contains_key(&path){return Err("unknown row path".into())}}Ok(())
            }
            inspect(value,"",&self.fields,e)?;
            for p in &e.parents {let ancestor=p.path.rsplit_once('.').map(|v|v.0);let active=ancestor.is_none_or(|a|path_get(value,a).is_some());match path_get(value,&p.path){Some(v)if v.is_object()=>{parents.insert(p.path.clone());},None if !active||!p.required=>{},_=>return Err(format!("missing/invalid parent {}",p.path))}}
        }else if object.len()>self.fields.len()+usize::from(self.definition.format>=2) || object.keys().any(|k|!self.fields.contains_key(k) && !(self.definition.format>=2 && k=="rowId")){return Err("unknown row field".into());}
        let mut cells=Vec::with_capacity(self.fields.len());
        for (i,f) in self.definition.fields.iter().enumerate() {
            let required=if let Some(e)=&self.definition.expansion {e.leaves[i].required&&f.name.rsplit_once('.').is_none_or(|(p,_)|parents.contains(p))}else{!f.optional};
            cells.push(match path_get(value,&f.name) {Some(v)=>self.scalar(i,v)?,None if !required=>Scalar::Missing,None=>return Err(format!("missing required field: {}",f.name))});
        }
        let key=if self.definition.format>=2 {
            let key=object.get("rowId").and_then(Value::as_str).ok_or("missing/invalid rowId metadata")?;
            if !valid_row_id(key) {return Err("invalid encoded rowId metadata".into());}key.to_owned()
        } else {let Scalar::String(key)=&cells[self.index(&self.definition.key)?] else {return Err("invalid row key".into())};key.clone()};
        if !valid_key(&key){return Err("invalid row key".into());}
        Ok(Row{key:key.clone(),cells,parents})
    }
    pub fn project(&self,row:&Row,selection:&[usize])->Value {
        let mut result=Map::new();
        for i in selection {let path=&self.definition.fields[*i].name;
            for p in &row.parents {if path.starts_with(&format!("{p}.")){if path_get(&Value::Object(result.clone()),p).is_none(){path_insert(&mut result,p,Value::Object(Map::new()));}}}
            if let Some(v)=row.cells[*i].json(){path_insert(&mut result,path,v);}}

        Value::Object(result)
    }
    pub fn full(&self,row:&Row)->Value {
        let mut full=self.project(row,&(0..self.definition.fields.len()).collect::<Vec<_>>());
        if self.definition.format>=2 {full.as_object_mut().unwrap().insert("rowId".into(),Value::String(row.key.clone()));}full
    }
}
/// Versioned typed tuple. A rowId identifies a row within its logical relation.
/// No topic/process incarnation is inserted; equal tuples across topics may match.
pub fn encode_row_id(components:&[Scalar])->Result<String,String> {
    if components.is_empty() || components.len()>16 {return Err("rowId requires 1..16 components".into());}
    let mut bytes=vec![1,components.len() as u8];
    for component in components {
        let (tag,payload)=match component {
            Scalar::String(s)=>(1,s.as_bytes().to_vec()),
            Scalar::Boolean(b)=>(2,vec![u8::from(*b)]),
            Scalar::Number(n)=>{let n=n.parse::<f64>().map_err(|_|"invalid rowId number")?;if !n.is_finite(){return Err("non-finite rowId number".into());}(3,(if n==0.0 {0.0}else{n}).to_bits().to_be_bytes().to_vec())},
            Scalar::Int64(n)=>(4,n.to_be_bytes().to_vec()),
            Scalar::Uint64(n)=>(5,n.to_be_bytes().to_vec()),
            Scalar::Decimal(n)=>(6,n.to_string_exact().into_bytes()),
            Scalar::Enum(_,_)=>return Err("enum identity components are unsupported".into()),
            Scalar::Missing|Scalar::Null=>return Err("rowId component must be present and non-null".into()),
        };
        bytes.push(tag);bytes.extend((payload.len() as u32).to_be_bytes());bytes.extend(payload);
        if 5+2*bytes.len()>MAX_KEY_BYTES {return Err("rowId exceeds 512-byte bound".into());}
    }
    Ok(format!("rid2:{}",bytes.iter().map(|b|format!("{b:02x}")).collect::<String>()))
}
pub fn valid_row_id(id:&str)->bool {
    fn parse(id:&str)->Option<Vec<Scalar>> {
        if !valid_key(id){return None;}let hex=id.strip_prefix("rid2:")?;
        if hex.len()%2!=0||!hex.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return None;}
        let bytes=(0..hex.len()).step_by(2).map(|i|u8::from_str_radix(&hex[i..i+2],16).ok()).collect::<Option<Vec<_>>>()?;
        if bytes.first()!=Some(&1){return None;}let count=*bytes.get(1)? as usize;if count==0||count>16{return None;}
        let mut pos:usize=2;let mut components=Vec::new();
        for _ in 0..count {
            let tag=*bytes.get(pos)?;pos+=1;let len=u32::from_be_bytes(bytes.get(pos..pos+4)?.try_into().ok()?) as usize;pos+=4;
            let payload=bytes.get(pos..pos.checked_add(len)?)?;pos+=len;
            components.push(match tag {
                1=>Scalar::String(std::str::from_utf8(payload).ok()?.into()),
                2=>Scalar::Boolean(match payload {[0]=>false,[1]=>true,_=>return None}),
                3=>{let v=f64::from_bits(u64::from_be_bytes(payload.try_into().ok()?));if !v.is_finite(){return None;}Scalar::Number(v.to_string())},
                4=>Scalar::Int64(i64::from_be_bytes(payload.try_into().ok()?)),
                5=>Scalar::Uint64(u64::from_be_bytes(payload.try_into().ok()?)),
                6=>{let s=std::str::from_utf8(payload).ok()?;let n=ExactDecimal::parse(s).ok()?;if s.len()>256||s.split('.').nth(1).is_some_and(|f|f.len()>128)||n.to_string_exact()!=s{return None;}Scalar::Decimal(n)},
                _=>return None,
            });
        }
        (pos==bytes.len()).then_some(components)
    }
    parse(id).and_then(|v|encode_row_id(&v).ok()).is_some_and(|v|v==id)
}

impl Scalar {
    pub fn json(&self)->Option<Value>{Some(match self {Self::Enum(domain,code)=>serde_json::json!({"domain":domain,"code":code}),Self::Missing=>return None,Self::Null=>Value::Null,Self::String(v)=>Value::String(v.clone()),Self::Boolean(v)=>Value::Bool(*v),Self::Number(v)=>serde_json::json!(v.parse::<f64>().unwrap()),Self::Int64(v)=>Value::String(v.to_string()),Self::Uint64(v)=>Value::String(v.to_string()),Self::Decimal(v)=>Value::String(v.to_string_exact())})}
    pub fn sort_token(&self)->String {
        match self {
            Self::Enum(domain,code)=>format!("2{domain}:{:08x}",(*code as u32)^(1<<31)),Self::Missing=>"0".into(),Self::Null=>"1".into(),Self::String(v)=>format!("2{v}"),Self::Boolean(v)=>format!("2{}",u8::from(*v)),
            Self::Number(v)=>{let bits=v.parse::<f64>().unwrap().to_bits();let ordered=if bits>>63==1 {!bits}else{bits^(1<<63)};format!("2{ordered:016x}")},
            Self::Int64(v)=>format!("2{:016x}",(*v as u64)^(1<<63)),Self::Uint64(v)=>format!("2{v:016x}"),Self::Decimal(v)=>format!("2{}",v.sortable_token())
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Topic {pub topic:String,pub schema:String}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {pub format:u32,pub schemas:Vec<Definition>,pub topics:Vec<Topic>}
#[derive(Clone)]
pub struct Catalog {manifest:Manifest,topics:BTreeMap<String,Schema>}
impl Catalog {
    pub fn new(manifest:Manifest)->Result<Self,String> {
        if manifest.format!=1 || manifest.topics.is_empty() || manifest.topics.len()>MAX_TOPICS || manifest.schemas.is_empty() || manifest.schemas.len()>MAX_TOPICS{return Err("catalog bounds/version".into());}
        let mut schemas=BTreeMap::new();let mut ids=BTreeSet::new();
        for definition in &manifest.schemas {let schema=Schema::new(definition.clone())?;if !ids.insert((definition.id.clone(),definition.version)) || schemas.insert(schema.fingerprint.clone(),schema).is_some(){return Err("duplicate schema identity".into());}}
        let mut topics=BTreeMap::new();
        for t in &manifest.topics {if !valid_name(&t.topic) || topics.contains_key(&t.topic){return Err("invalid or duplicate logical topic".into());}let s=schemas.get(&t.schema).ok_or("unknown schema fingerprint")?;topics.insert(t.topic.clone(),s.clone());}
        Ok(Self{manifest,topics})
    }
    pub fn manifest(&self)->&Manifest {&self.manifest}
    pub fn schema(&self,topic:&str,fingerprint:&str)->Result<&Schema,String> {let s=self.topics.get(topic).ok_or("unknown logical topic")?;if s.fingerprint()!=fingerprint{return Err("schema fingerprint mismatch".into());}Ok(s)}
    pub fn topics(&self)->impl Iterator<Item=(&str,&Schema)> {self.topics.iter().map(|(t,s)|(t.as_str(),s))}
}

/// Reject duplicate JSON members before deserializing immutable manifests/config.
pub fn strict_json(input:&[u8],max_bytes:usize)->Result<Value,String> {
    if input.len()>max_bytes{return Err("JSON byte bound".into());}
    struct Strict(Value);
    impl<'de> Deserialize<'de> for Strict {
        fn deserialize<D:serde::Deserializer<'de>>(d:D)->Result<Self,D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value=Strict;
                fn expecting(&self,f:&mut std::fmt::Formatter)->std::fmt::Result {f.write_str("JSON without duplicate keys")}
                fn visit_bool<E:serde::de::Error>(self,v:bool)->Result<Strict,E>{Ok(Strict(v.into()))}
                fn visit_i64<E:serde::de::Error>(self,v:i64)->Result<Strict,E>{Ok(Strict(v.into()))}
                fn visit_u64<E:serde::de::Error>(self,v:u64)->Result<Strict,E>{Ok(Strict(v.into()))}
                fn visit_f64<E:serde::de::Error>(self,v:f64)->Result<Strict,E>{serde_json::Number::from_f64(v).map(|n|Strict(Value::Number(n))).ok_or_else(||E::custom("non-finite number"))}
                fn visit_str<E:serde::de::Error>(self,v:&str)->Result<Strict,E>{Ok(Strict(v.into()))}
                fn visit_string<E:serde::de::Error>(self,v:String)->Result<Strict,E>{Ok(Strict(v.into()))}
                fn visit_unit<E:serde::de::Error>(self)->Result<Strict,E>{Ok(Strict(Value::Null))}
                fn visit_seq<A:serde::de::SeqAccess<'de>>(self,mut a:A)->Result<Strict,A::Error>{let mut v=Vec::new();while let Some(Strict(x))=a.next_element()?{v.push(x);}Ok(Strict(v.into()))}
                fn visit_map<A:serde::de::MapAccess<'de>>(self,mut a:A)->Result<Strict,A::Error>{let mut m=Map::new();while let Some(k)=a.next_key::<String>()?{if m.contains_key(&k){return Err(serde::de::Error::custom("duplicate JSON member"));}let Strict(v)=a.next_value()?;m.insert(k,v);}Ok(Strict(m.into()))}
            }
            d.deserialize_any(Visitor)
        }
    }
    serde_json::from_slice::<Strict>(input).map(|s|s.0).map_err(|e|e.to_string())
}

#[cfg(test)]mod tests {
    use super::*;use serde_json::json;
    pub fn example()->Schema{Schema::new(serde_json::from_value(json!({"format":1,"id":"orders","version":1,"key":"id","fields":[{"name":"id","kind":"string","optional":false,"nullable":false},{"name":"price","kind":"decimal","optional":false,"nullable":false},{"name":"size","kind":"uint64","optional":false,"nullable":false},{"name":"memo","kind":"string","optional":true,"nullable":true}]})).unwrap()).unwrap()}
    #[test]fn exact_scalar_and_state_admission(){let s=example();for row in [json!({"id":"same","price":"12345678901234567890.0001","size":"18446744073709551615"}),json!({"id":"same","price":"-0.001","size":"0","memo":null})]{let r=s.row(&row).unwrap();assert_eq!(s.full(&r),row);}for row in [json!({"id":"x","price":"1.0","size":"1"}),json!({"id":"x","price":"1","size":1}),json!({"id":"x","price":"1","size":"18446744073709551616"}),json!({"id":"x","price":"1","size":"1","unknown":false})]{assert!(s.row(&row).is_err());}}
    #[test]fn hostile_duplicates_and_structures_fail(){for s in [br#"{"a":1,"a":2}"#.as_slice(),br#"{"nested":{"a":1,"a":2}}"#.as_slice()]{assert!(strict_json(s,4096).is_err());}let mut d=example().definition().clone();d.fields[1].name="constructor".into();assert!(Schema::new(d).is_err());let mut d=example().definition().clone();d.fields[1].name="id".into();assert!(Schema::new(d).is_err());}
    #[test]fn fingerprint_binds_schema_and_catalog(){let s=example();let a=s.fingerprint();let mut d=s.definition().clone();d.fields[1].nullable=true;assert_ne!(a,Schema::new(d).unwrap().fingerprint());let manifest=Manifest{format:1,schemas:vec![s.definition().clone()],topics:vec![Topic{topic:"orders".into(),schema:a.into()},Topic{topic:"positions".into(),schema:a.into()}]};let c=Catalog::new(manifest).unwrap();assert!(c.schema("other",a).is_err());assert!(c.schema("orders","wrong").is_err());}
    #[test]fn sortable_exact_decimal_matches_math(){let values=["-100000","-10","-1.2","-1.19","-1","-0.01","0","0.001","1","1.01","1.1","1.11","2","10000"];let scalars=values.iter().map(|s|Scalar::Decimal(ExactDecimal::parse(s).unwrap())).collect::<Vec<_>>();for (a,b)in scalars.iter().zip(scalars.iter().skip(1)){assert!(a.sort_token()<b.sort_token(),"{:?} vs {:?}",a,b);}}
}
