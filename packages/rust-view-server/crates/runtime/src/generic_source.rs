//! Pinned FileDescriptorSet scalar decoding. No registry discovery or scripts.
use prost::Message;
use rust_differential_product_core::{schema::{Schema,Kind,Definition,Field as SchemaField,valid_key,valid_name},generic::Mutation};
use serde::{Deserialize,Serialize};
use serde_json::{Map,Value};
use sha2::{Digest,Sha256};
use std::collections::{BTreeMap,BTreeSet};

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Descriptor {pub schema_id:u32,pub message_index:u32,#[serde(default,skip_serializing_if="Option::is_none")] pub message_name:Option<String>,pub descriptor_hex:String}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mapping {pub field:String,pub tag:u32,#[serde(default)]pub null_tag:Option<u32>}
#[derive(Clone)]
pub struct LegacyDecoder {schema:Schema,key:Validated,value:Validated,mapping:Vec<Mapping>,key_tag:u32,key_fields:Vec<KeyField>,key_schema:Option<Schema>,identity:Option<Identity>,typed_source:Option<rust_differential_product_core::typed_source::TypedSource>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyField {pub name:String,pub tag:u32,pub kind:Kind}
pub use rust_differential_product_core::typed_source::SourcePolicy;
#[derive(Clone,Copy,Debug,Eq,PartialEq,Ord,PartialOrd,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum ComponentSource {Key,Value}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityComponent {pub source:ComponentSource,pub field:String}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {pub source_policy:SourcePolicy,pub components:Vec<IdentityComponent>}
#[derive(Clone)]
struct Validated {schema_id:u32,message_index:u32,fields:BTreeMap<u32,Field>,proto3:bool}
// Only metadata needed to admit this closed scalar slice is decoded. Nested,
// enums, extensions, real oneofs, dependencies and repeated values are rejected.
#[derive(Clone,PartialEq,Message)]
struct Set {#[prost(message,repeated,tag="1")]file:Vec<File>}
#[derive(Clone,PartialEq,Message)]
struct File {#[prost(string,repeated,tag="3")]dependency:Vec<String>,#[prost(message,repeated,tag="4")]message_type:Vec<Msg>,#[prost(bytes,repeated,tag="5")]enum_type:Vec<Vec<u8>>,#[prost(bytes,repeated,tag="6")]service:Vec<Vec<u8>>,#[prost(message,repeated,tag="7")]extension:Vec<Field>,#[prost(string,optional,tag="12")]syntax:Option<String>}
#[derive(Clone,PartialEq,Message)]
struct Msg {#[prost(string,optional,tag="1")]name:Option<String>,#[prost(message,repeated,tag="2")]field:Vec<Field>,#[prost(message,repeated,tag="3")]nested:Vec<Msg>,#[prost(bytes,repeated,tag="4")]enums:Vec<Vec<u8>>,#[prost(bytes,repeated,tag="5")]extension_range:Vec<Vec<u8>>,#[prost(message,repeated,tag="6")]extension:Vec<Field>,#[prost(bytes,repeated,tag="8")]oneof:Vec<Vec<u8>>}
#[derive(Clone,PartialEq,Message)]
struct Field {#[prost(string,optional,tag="1")]name:Option<String>,#[prost(string,optional,tag="2")]extendee:Option<String>,#[prost(int32,optional,tag="3")]number:Option<i32>,#[prost(int32,optional,tag="4")]label:Option<i32>,#[prost(int32,optional,tag="5")]kind:Option<i32>,#[prost(string,optional,tag="6")]type_name:Option<String>,#[prost(string,optional,tag="7")]default_value:Option<String>,#[prost(int32,optional,tag="9")]oneof_index:Option<i32>,#[prost(bool,optional,tag="17")]proto3_optional:Option<bool>}
impl Validated {
    fn new(d:&Descriptor)->Result<Self,String>{
        if d.schema_id==0||d.descriptor_hex.len()>131072||d.descriptor_hex.len()%2!=0||!d.descriptor_hex.bytes().all(|b|b.is_ascii_hexdigit()){return Err("pinned descriptor bound/identity".into());}
        let bytes=(0..d.descriptor_hex.len()).step_by(2).map(|i|u8::from_str_radix(&d.descriptor_hex[i..i+2],16).map_err(|_|"descriptor hex".to_string())).collect::<Result<Vec<_>,_>>()?;
        let mut set=Set::decode(bytes.as_slice()).map_err(|_|"malformed FileDescriptorSet")?;
        if set.file.len()!=1{return Err("descriptor requires exactly one self-contained file".into());}let file=set.file.remove(0);
        if !file.dependency.is_empty()||!file.enum_type.is_empty()||!file.extension.is_empty()||!file.service.is_empty()||file.message_type.is_empty()||file.message_type.len()>16{return Err("unsupported descriptor dependencies/enums/extensions/services".into());}
        let syntax=file.syntax.as_deref().unwrap_or("proto2");if !matches!(syntax,"proto2"|"proto3"){return Err("unsupported protobuf syntax".into());}
        let msg=file.message_type.get(d.message_index as usize).ok_or("descriptor message index")?;
        if !msg.nested.is_empty()||!msg.enums.is_empty()||!msg.extension.is_empty()||!msg.extension_range.is_empty()||msg.field.is_empty()||msg.field.len()>128{return Err("unsupported nested/enum/extension or field bound".into());}
        let mut fields=BTreeMap::new();let mut names=BTreeSet::new();let mut oneofs=BTreeSet::new();
        for f in &msg.field {
            let tag=f.number.ok_or("descriptor field lacks tag")?;
            if tag<=0||tag>536870911||(19000..=19999).contains(&tag)||!matches!(f.label,Some(1|2))||!matches!(f.kind,Some(1|3|4|6|7|8|9|15|16|17|18))||f.extendee.is_some()||f.type_name.is_some()||f.default_value.is_some(){return Err("unsupported protobuf scalar descriptor".into());}
            if let Some(index)=f.oneof_index {if syntax!="proto3"||f.proto3_optional!=Some(true)||index<0||index as usize>=msg.oneof.len()||!oneofs.insert(index){return Err("only synthetic proto3 optional oneofs admitted".into());}}
            else if f.proto3_optional==Some(true){return Err("optional field missing synthetic oneof".into());}
            if !names.insert(f.name.clone().ok_or("descriptor field lacks name")?)||fields.insert(tag as u32,f.clone()).is_some(){return Err("duplicate descriptor tag/name".into());}
        }
        if oneofs.len()!=msg.oneof.len(){return Err("unsupported real or unused oneof".into());}
        Ok(Self{schema_id:d.schema_id,message_index:d.message_index,fields,proto3:syntax=="proto3"})
    }
    fn decode(&self,input:&[u8])->Result<BTreeMap<u32,Value>,String>{
        let e=crate::wire::envelope(input)?;if e.schema_id!=self.schema_id||e.indexes!=[self.message_index]{return Err("unknown pinned schema ID/message index".into());}
        let mut pos=0;let mut fields=BTreeMap::new();
        while pos<e.payload.len(){let tag=varint(e.payload,&mut pos)?;let number=u32::try_from(tag>>3).map_err(|_|"field number overflow")?;let wire=tag&7;let field=self.fields.get(&number).ok_or("unknown protobuf source field")?;if fields.contains_key(&number){return Err("duplicate scalar protobuf field".into());}
            let kind=field.kind.unwrap();let expected=match kind{1|6|16=>1,7|15=>5,9=>2,_=>0};if wire!=expected{return Err("protobuf wire type mismatch".into());}
            let value=match kind {
                9=>{let len=usize::try_from(varint(e.payload,&mut pos)?).map_err(|_|"string length")?;if len>4096||pos.checked_add(len).is_none_or(|end|end>e.payload.len()){return Err("protobuf string bound/truncation".into());}let v=std::str::from_utf8(&e.payload[pos..pos+len]).map_err(|_|"invalid protobuf UTF8")?;pos+=len;Value::String(v.into())},
                1=>{let v=f64::from_bits(fixed(e.payload,&mut pos,8)?);if !v.is_finite(){return Err("non-finite source number".into());}serde_json::json!(v)},
                8=>{let n=varint(e.payload,&mut pos)?;if n>1{return Err("invalid protobuf boolean".into());}Value::Bool(n==1)},
                3=>Value::String((varint(e.payload,&mut pos)? as i64).to_string()),
                4=>Value::String(varint(e.payload,&mut pos)?.to_string()),
                6=>Value::String(fixed(e.payload,&mut pos,8)?.to_string()),
                16=>Value::String((fixed(e.payload,&mut pos,8)? as i64).to_string()),
                7=>Value::String(fixed(e.payload,&mut pos,4)?.to_string()),
                15=>Value::String((fixed(e.payload,&mut pos,4)? as i32).to_string()),
                17=>{let n=varint(e.payload,&mut pos)?;if n>u32::MAX as u64{return Err("sint32 overflow".into());}Value::String((((n>>1) as i32)^-((n&1) as i32)).to_string())},
                18=>{let n=varint(e.payload,&mut pos)?;Value::String((((n>>1) as i64)^-((n&1) as i64)).to_string())},
                _=>return Err("unsupported protobuf kind".into())
            };fields.insert(number,value);
        }
        // Presence survives decoding; the portable schema decides whether absence is allowed.
        for (tag,f) in &self.fields {if !fields.contains_key(tag)&&f.label==Some(2){return Err("missing required protobuf scalar".into());}}
        Ok(fields)
    }
}
fn varint(b:&[u8],p:&mut usize)->Result<u64,String>{let mut n=0;for shift in (0..70).step_by(7){let v=*b.get(*p).ok_or("truncated protobuf varint")?;*p+=1;if shift==63&&v>1{return Err("protobuf varint overflow".into());}n|=((v&127) as u64)<<shift;if v&128==0{return Ok(n);}}Err("protobuf varint overflow".into())}
fn fixed(b:&[u8],p:&mut usize,n:usize)->Result<u64,String>{let end=p.checked_add(n).ok_or("fixed overflow")?;let bytes=b.get(*p..end).ok_or("truncated protobuf fixed scalar")?;let mut out=[0u8;8];out[..n].copy_from_slice(bytes);*p=end;Ok(u64::from_le_bytes(out))}
fn compatible(kind:Kind,wire:Option<i32>)->bool {match kind {Kind::Enum=>false,Kind::String|Kind::Decimal=>wire==Some(9),Kind::Boolean=>wire==Some(8),Kind::Number=>wire==Some(1),Kind::Int64=>matches!(wire,Some(3|15|16|17|18)),Kind::Uint64=>matches!(wire,Some(4|6|7))}}

impl LegacyDecoder {
    pub fn new(schema:Schema,key:&Descriptor,value:&Descriptor,key_tag:u32,mapping:Vec<Mapping>)->Result<Self,String>{
        if schema.definition().format!=1{return Err("schema v2 requires explicit typed identity".into());}
        Self::admit(schema,key,value,key_tag,mapping,vec![],None)
    }
    pub fn new_identity(schema:Schema,key:&Descriptor,value:&Descriptor,mapping:Vec<Mapping>,key_fields:Vec<KeyField>,identity:Identity)->Result<Self,String>{
        if schema.definition().format!=2{return Err("typed rowId identity requires schema v2".into());}
        Self::admit(schema,key,value,0,mapping,key_fields,Some(identity))
    }
    fn admit(schema:Schema,key:&Descriptor,value:&Descriptor,key_tag:u32,mapping:Vec<Mapping>,key_fields:Vec<KeyField>,identity:Option<Identity>)->Result<Self,String>{
        let key=Validated::new(key)?;let value=Validated::new(value)?;
        let key_schema=if let Some(rule)=&identity {
            if key_fields.is_empty()||key_fields.len()>64||key_fields.len()!=key.fields.len(){return Err("key_fields must cover every key descriptor field".into());}
            let mut tags=BTreeSet::new();let mut names=BTreeSet::new();
            for f in &key_fields {
                if !valid_name(&f.name)||f.name=="rowId"||!tags.insert(f.tag)||!names.insert(&f.name){return Err("invalid/duplicate key field".into());}
                let wire=key.fields.get(&f.tag).ok_or("key field tag absent from descriptor")?;
                if !compatible(f.kind,wire.kind){return Err("incompatible key field scalar mapping".into());}
                if key.proto3&&wire.proto3_optional!=Some(true){return Err(format!("SOURCE-PRESENCE: key field '{}' message index {} tag {} requires explicit presence; declare proto3 optional",f.name,key.message_index,f.tag));}
            }
            if rule.components.is_empty()||rule.components.len()>16{return Err("identity requires 1..16 components".into());}
            let mut components=BTreeSet::new();
            for c in &rule.components {
                if !components.insert((c.source,c.field.clone())){return Err("duplicate identity component".into());}
                match c.source {
                    ComponentSource::Key=>{if !names.contains(&c.field){return Err("unknown identity key field".into());}},
                    ComponentSource::Value=>{if rule.source_policy!=SourcePolicy::Delete{return Err("compact source identity must be key-only".into());}
                        let f=schema.field(&c.field)?;if f.optional||f.nullable{return Err("identity value field must be required and non-null".into());}}
                }
            }
            Some(Schema::new(Definition{expansion:None,format:2,id:"identity_key".into(),version:2,key:"rowId".into(),fields:key_fields.iter().map(|f|SchemaField{name:f.name.clone(),kind:f.kind,optional:false,nullable:false}).collect()})?)
        }else{
            if key.fields.len()!=1||key.fields.get(&key_tag).is_none_or(|f|f.kind!=Some(9)){return Err("key descriptor must be exactly one string field".into());}
            if key.proto3&&key.fields[&key_tag].proto3_optional!=Some(true){return Err(format!("SOURCE-PRESENCE: key message index {} tag {key_tag} requires explicit presence; declare proto3 optional",key.message_index));}None
        };
        let mut names=BTreeSet::new();let mut tags=BTreeSet::new();
        for m in &mapping {
            let f=schema.field(&m.field)?;if !names.insert(&m.field)||!tags.insert(m.tag){return Err("duplicate field mapping".into());}let source=value.fields.get(&m.tag).ok_or("mapping tag absent from descriptor")?;
            if !compatible(f.kind,source.kind){return Err("incompatible source scalar mapping".into());}
            if value.proto3&&source.proto3_optional!=Some(true){return Err(format!("SOURCE-PRESENCE: field '{}' in message index {} tag {} requires explicit presence; declare proto3 optional (portable required/optional is unchanged)",m.field,value.message_index,m.tag));}
            if let Some(tag)=m.null_tag {let marker=value.fields.get(&tag).ok_or("null marker absent from descriptor")?;
                if value.proto3&&marker.proto3_optional!=Some(true){return Err(format!("SOURCE-PRESENCE: null marker for field '{}' in message index {} tag {tag} requires explicit presence; declare proto3 optional",m.field,value.message_index));}
                if !f.nullable||marker.kind!=Some(8)||marker.proto3_optional!=Some(true)||!tags.insert(tag)||source.proto3_optional!=Some(true){return Err("null marker requires nullable field and two present/absent scalar optionals".into());}}
            else if f.nullable{return Err("nullable source mapping requires explicit null marker".into());}
        }
        if names.len()!=schema.definition().fields.len()||tags.len()!=value.fields.len(){return Err("mapping must cover every schema and descriptor field".into());}
        let typed_source=identity.as_ref().map(|rule| {
            use rust_differential_product_core::typed_source as typed;
            typed::TypedSource::new(schema.clone(),typed::SourceDefinition {
                key_fields:key_fields.iter().map(|f|typed::KeyField{name:f.name.clone(),tag:f.tag,kind:f.kind}).collect(),
                identity:typed::Identity{source_policy:rule.source_policy,components:rule.components.iter().map(|c|typed::Component{source:match c.source{ComponentSource::Key=>"key",ComponentSource::Value=>"value"}.into(),field:c.field.clone()}).collect()}
            })
        }).transpose()?;
        Ok(Self{schema,key,value,mapping,key_tag,key_fields,key_schema,identity,typed_source})
    }
    pub fn decode(&self,key:Option<&[u8]>,value:Option<&[u8]>)->Result<(String,[u8;32],Mutation),String>{
        let bytes=key.ok_or("source key is required")?;let mut decoded_key=self.key.decode(bytes)?;
        let identity=Sha256::digest(bytes).into();
        let legacy_id=if self.identity.is_none(){let id=decoded_key.remove(&self.key_tag).and_then(|v|v.as_str().map(str::to_owned)).ok_or("missing source key")?;if !valid_key(&id){return Err("invalid source key".into());}Some(id)}else{None};
        let mut key_values=BTreeMap::new();
        if let Some(schema)=&self.key_schema {for (i,f) in self.key_fields.iter().enumerate(){let v=decoded_key.get(&f.tag).ok_or_else(||format!("missing identity key field: {}",f.name))?;key_values.insert(f.name.clone(),schema.scalar(i,v)?);}}
        let mut row=Map::new();
        if let Some(value)=value {
            let mut decoded=self.value.decode(value)?;
            for m in &self.mapping {let v=decoded.remove(&m.tag);let null=m.null_tag.and_then(|tag|decoded.remove(&tag));if let Some(marker)=null {if marker!=Value::Bool(true)||v.is_some(){return Err("invalid/ambiguous explicit null marker".into());}row.insert(m.field.clone(),Value::Null);}else if let Some(v)=v{row.insert(m.field.clone(),v);}}
        }
        if let Some(source)=&self.typed_source {
            let key=Value::Object(self.key_fields.iter().map(|f|Ok((f.name.clone(),decoded_key.get(&f.tag).ok_or("missing key field")?.clone()))).collect::<Result<Map<_,_>,String>>()?);
            let row=Value::Object(row);
            let mutation=source.admit(&key,value.map(|_|&row))?;
            let id=match &mutation{Mutation::Delete{key}=>key.clone(),Mutation::Upsert{row}=>row["rowId"].as_str().ok_or("admitted row lacks rowId")?.to_owned()};
            return Ok((id,identity,mutation));
        }
        let id=legacy_id.unwrap();
        if value.is_none(){return Ok((id.clone(),identity,Mutation::Delete{key:id}));}
        let row=Value::Object(row);let admitted=self.schema.row(&row)?;if admitted.key!=id{return Err("key/full after-image row ID mismatch".into());}Ok((id,identity,Mutation::Upsert{row:self.schema.full(&admitted)}))
    }
}

#[cfg(test)]mod tests {
    use super::*;use rust_differential_product_core::schema::{Definition,Field as SchemaField};use serde_json::json;
    fn field(name:&str,tag:i32,kind:i32)->Field{Field{name:Some(name.into()),number:Some(tag),label:Some(1),kind:Some(kind),..Default::default()}}
    fn descriptor(fields:Vec<Field>,id:u32)->Descriptor{let set=Set{file:vec![File{syntax:Some("proto2".into()),message_type:vec![Msg{name:Some("Row".into()),field:fields,..Default::default()}],..Default::default()}]};Descriptor{message_name:None,schema_id:id,message_index:0,descriptor_hex:set.encode_to_vec().iter().map(|b|format!("{b:02x}")).collect()}}
    fn schema()->Schema{Schema::new(Definition{expansion:None,format:1,id:"positions".into(),version:1,key:"id".into(),fields:vec![SchemaField{name:"id".into(),kind:Kind::String,optional:false,nullable:false},SchemaField{name:"quantity".into(),kind:Kind::Uint64,optional:false,nullable:false},SchemaField{name:"price".into(),kind:Kind::Decimal,optional:false,nullable:false}]}).unwrap()}
    fn decoder()->Decoder{Decoder::new(schema(),&descriptor(vec![field("id",1,9)],1),&descriptor(vec![field("id",1,9),field("quantity",2,4),field("price",3,9)],42),1,vec![Mapping{field:"id".into(),tag:1,null_tag:None},Mapping{field:"quantity".into(),tag:2,null_tag:None},Mapping{field:"price".into(),tag:3,null_tag:None}]).unwrap()}
    fn frame(id:u32,payload:&[u8])->Vec<u8>{let mut v=vec![0];v.extend(id.to_be_bytes());v.push(0);v.extend(payload);v}
    #[test]fn pinned_descriptor_exact_scalars_and_tombstone(){let d=decoder();let key=frame(1,&[10,1,b'a']);let mut body=vec![10,1,b'a',16];body.extend([255;9]);body.push(1);body.extend([26,4,b'1',b'.',b'0',b'1']);let value=frame(42,&body);let (id,_,m)=d.decode(Some(&key),Some(&value)).unwrap();assert_eq!(id,"a");assert!(matches!(m,Mutation::Upsert{row} if row==json!({"id":"a","quantity":"18446744073709551615","price":"1.01"})));assert!(matches!(d.decode(Some(&key),None).unwrap().2,Mutation::Delete{key} if key=="a"));}
    #[test]fn unknown_malformed_duplicate_and_key_mismatch_fail(){let d=decoder();let key=frame(1,&[10,1,b'a']);for body in [vec![10,1,b'b',16,1,26,1,b'1'],vec![10,1,b'a',10,1,b'a',16,1,26,1,b'1'],vec![10,1,b'a',16,1,26,1,b'1',32,0],vec![10,1,b'a',16,128]]{assert!(d.decode(Some(&key),Some(&frame(42,&body))).is_err());}assert!(d.decode(Some(&key),Some(&frame(43,&[]))).is_err());assert!(d.decode(None,None).is_err());}
    #[test]fn incompatible_descriptor_fails_before_data(){let mut bad=descriptor(vec![field("id",1,9)],1);bad.descriptor_hex="é".into();assert!(Validated::new(&bad).is_err());let mut repeated=field("id",1,9);repeated.label=Some(3);assert!(Validated::new(&descriptor(vec![repeated],1)).is_err());let mut nested=field("id",1,11);nested.type_name=Some("Nested".into());assert!(Validated::new(&descriptor(vec![nested],1)).is_err());assert!(Decoder::new(schema(),&descriptor(vec![field("id",1,9)],1),&descriptor(vec![field("id",1,9),field("quantity",2,9),field("price",3,9)],42),1,vec![]).is_err());}
}

#[derive(Clone)]
pub enum Decoder {Legacy(LegacyDecoder),Expanded(crate::expanded_source::ExpandedDecoder)}
impl Decoder {
 pub fn new(schema:Schema,key:&Descriptor,value:&Descriptor,key_tag:u32,mapping:Vec<Mapping>)->Result<Self,String>{LegacyDecoder::new(schema,key,value,key_tag,mapping).map(Self::Legacy)}
 pub fn new_identity(schema:Schema,key:&Descriptor,value:&Descriptor,mapping:Vec<Mapping>,key_fields:Vec<KeyField>,identity:Identity)->Result<Self,String>{if schema.definition().format==3{crate::expanded_source::ExpandedDecoder::new(schema,key,value,mapping,key_fields,identity).map(Self::Expanded)}else{LegacyDecoder::new_identity(schema,key,value,mapping,key_fields,identity).map(Self::Legacy)}}
 pub fn decode(&self,key:Option<&[u8]>,value:Option<&[u8]>)->Result<(String,[u8;32],Mutation),String>{match self{Self::Legacy(d)=>d.decode(key,value),Self::Expanded(d)=>d.decode(key,value)}}
}
