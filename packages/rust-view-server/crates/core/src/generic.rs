//! Catalog-driven raw queries sharing one private incremental membership evaluator.
//! Opening a new shape visits its relation once. Mutations visit only the changed
//! keys and that relation's admitted shapes; ranked windows use AVL rank selection.
pub use crate::semantics::SemanticProfile;
use crate::semantics::{normalized, sort_token};
use crate::{common::{Row as RankedRow,SortDirection,RankedRows},execution_contract::MembershipChange,product_engine::MembershipEngine,schema::{Catalog,Row,Scalar,Schema,Kind,valid_key}};
use serde::{Deserialize,Serialize};
use serde_json::Value;
use std::collections::{BTreeMap,BTreeSet};

pub fn non_null_option<'de,D:serde::Deserializer<'de>,T:Deserialize<'de>>(d:D)->Result<Option<T>,D::Error>{T::deserialize(d).map(Some)}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(tag="op",rename_all="snake_case",deny_unknown_fields)]
pub enum Predicate {
    Eq{field:String,value:Value},Ne{field:String,value:Value},Lt{field:String,value:Value},Le{field:String,value:Value},Gt{field:String,value:Value},Ge{field:String,value:Value},
    Text{field:String,value:String,match_kind:String,#[serde(default)]case_sensitive:bool,#[serde(default)]accent_sensitive:bool},
    Contains{field:String,value:String},#[serde(rename="startsWith")]StartsWith{field:String,value:String},#[serde(rename="endsWith")]EndsWith{field:String,value:String},
    In{field:String,values:Vec<Value>},IsMissing{field:String},IsNull{field:String},IsValue{field:String},
    And{clauses:Vec<Predicate>},Or{clauses:Vec<Predicate>},Not{clause:Box<Predicate>},
}
impl Predicate {
    pub fn requires_text(&self)->bool {match self {Self::Text{..}|Self::Contains{..}|Self::StartsWith{..}|Self::EndsWith{..}=>true,Self::And{clauses}|Self::Or{clauses}=>clauses.iter().any(Self::requires_text),Self::Not{clause}=>clause.requires_text(),_=>false}}
}
#[derive(Clone,Copy,Debug,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Direction {Asc,Desc}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Order {#[serde(default,deserialize_with="non_null_option",skip_serializing_if="Option::is_none")]pub field:Option<String>,#[serde(default,deserialize_with="non_null_option",skip_serializing_if="Option::is_none")]pub aggregate:Option<String>,pub direction:Direction}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {#[serde(default,deserialize_with="non_null_option",skip_serializing_if="Option::is_none")]pub semantic_profile:Option<SemanticProfile>,#[serde(default,deserialize_with="non_null_option",skip_serializing_if="Option::is_none")]pub global:Option<bool>,#[serde(default,deserialize_with="non_null_option",skip_serializing_if="Option::is_none")]pub having:Option<Predicate>,#[serde(default,deserialize_with="non_null_option",skip_serializing_if="Option::is_none")]pub select:Option<Vec<String>>,#[serde(default,deserialize_with="non_null_option",skip_serializing_if="Option::is_none")]pub group_by:Option<Vec<String>>,#[serde(default,deserialize_with="non_null_option",skip_serializing_if="Option::is_none")]pub aggregates:Option<BTreeMap<String,crate::grouped::Aggregate>>,#[serde(default,rename="where")]pub predicate:Option<Predicate>,#[serde(default)]pub order_by:Vec<Order>}
#[derive(Clone)]
pub(crate) enum Check {Text(usize,u8,String),ProfileText(usize,String,String,bool,bool),Compare(usize,u8,Scalar,Option<SemanticProfile>),In(usize,Vec<Scalar>),State(usize,u8),And(Vec<Check>),Or(Vec<Check>),Not(Box<Check>)}
impl Check {
    pub(crate) fn matches(&self,row:&Row)->bool {match self {
        Self::Text(i,op,needle)=>match &row.cells[*i]{Scalar::String(value)=>match op{0=>value.contains(needle.as_str()),1=>value.starts_with(needle.as_str()),_=>value.ends_with(needle.as_str())},_=>false},
        Self::ProfileText(i,op,needle,case,accent)=>{let matched=match &row.cells[*i]{Scalar::String(value)=>{let value=normalized(value,*case,*accent);match op.as_str(){"eq"|"ne"=>value==*needle,"contains"|"notContains"=>value.contains(needle),"startsWith"=>value.starts_with(needle),"endsWith"=>value.ends_with(needle),_=>false}},_=>false};if matches!(op.as_str(),"ne"|"notContains"){!matched}else{matched}},
        Self::Compare(i,op,v,profile)=>{let x=&row.cells[*i];if matches!(x,Scalar::Missing|Scalar::Null){return false;}let c=sort_token(x,*profile,false).cmp(&sort_token(v,*profile,false));match op{0=>c.is_eq(),1=>!c.is_eq(),2=>c.is_lt(),3=>!c.is_gt(),4=>c.is_gt(),_=>!c.is_lt()}},
        Self::In(i,values)=>!matches!(row.cells[*i],Scalar::Missing|Scalar::Null)&&values.contains(&row.cells[*i]),
        Self::State(i,op)=>match op{0=>matches!(row.cells[*i],Scalar::Missing),1=>matches!(row.cells[*i],Scalar::Null),_=>!matches!(row.cells[*i],Scalar::Missing|Scalar::Null)},
        Self::And(v)=>v.iter().all(|x|x.matches(row)),Self::Or(v)=>v.iter().any(|x|x.matches(row)),Self::Not(x)=>!x.matches(row)
    }}
}
pub(crate) trait PredicateSchema {
 fn index(&self,name:&str)->Result<usize,String>;
 fn field(&self,index:usize)->crate::schema::Field;
 fn scalar(&self,index:usize,value:&Value)->Result<Scalar,String>;
}
impl PredicateSchema for Schema {
 fn index(&self,name:&str)->Result<usize,String>{Schema::index(self,name)}
 fn field(&self,index:usize)->crate::schema::Field{self.definition().fields[index].clone()}
 fn scalar(&self,index:usize,value:&Value)->Result<Scalar,String>{Schema::scalar(self,index,value)}
}
pub(crate) fn compile_profile(schema:&dyn PredicateSchema,p:&Predicate,depth:usize,nodes:&mut usize,profile:Option<SemanticProfile>)->Result<Check,String> {
    *nodes+=1;if depth>32||*nodes>256{return Err("predicate depth/node bound".into());}
    let compare=|field:&str,value:&Value,op:u8|->Result<Check,String>{let i=schema.index(field)?;if value.is_null()||matches!(schema.field(i).kind,Kind::Boolean)&&op>1{return Err("unsupported scalar operand/operator".into());}if profile.is_some()&&schema.field(i).kind==Kind::String&&op<2{let text=value.as_str().ok_or("string operand")?;schema.scalar(i,value)?;return Ok(Check::ProfileText(i,if op==0{"eq"}else{"ne"}.into(),normalized(text,false,false),false,false));}Ok(Check::Compare(i,op,schema.scalar(i,value)?,profile))};
    Ok(match p {
        Predicate::Text{field,value,match_kind,case_sensitive,accent_sensitive}=>{if profile.is_none()||!["eq","ne","contains","notContains","startsWith","endsWith"].contains(&match_kind.as_str()){return Err("text match requires supported semantic profile".into())}let i=schema.index(field)?;if schema.field(i).kind!=Kind::String{return Err("text requires string field".into())}schema.scalar(i,&Value::String(value.clone()))?;Check::ProfileText(i,match_kind.clone(),normalized(value,*case_sensitive,*accent_sensitive),*case_sensitive,*accent_sensitive)},
        Predicate::Eq{field,value}=>compare(field,value,0)?,Predicate::Ne{field,value}=>compare(field,value,1)?,Predicate::Lt{field,value}=>compare(field,value,2)?,Predicate::Le{field,value}=>compare(field,value,3)?,Predicate::Gt{field,value}=>compare(field,value,4)?,Predicate::Ge{field,value}=>compare(field,value,5)?,
        Predicate::Contains{field,value}|Predicate::StartsWith{field,value}|Predicate::EndsWith{field,value}=>{let i=schema.index(field)?;if schema.field(i).kind!=Kind::String{return Err("text predicate requires string field".into())}schema.scalar(i,&Value::String(value.clone()))?;if profile.is_some(){Check::ProfileText(i,match p{Predicate::Contains{..}=>"contains",Predicate::StartsWith{..}=>"startsWith",_=>"endsWith"}.into(),normalized(value,false,false),false,false)}else{Check::Text(i,match p{Predicate::Contains{..}=>0,Predicate::StartsWith{..}=>1,_=>2},value.clone())}},
        Predicate::In{field,values}=>{if values.is_empty()||values.len()>64{return Err("in operand bound".into());}let i=schema.index(field)?;let mut parsed=Vec::new();for v in values{if v.is_null(){return Err("in null unsupported; use is_null".into());}parsed.push(schema.scalar(i,v)?);}Check::In(i,parsed)},
        Predicate::IsMissing{field}=>{let i=schema.index(field)?;if !schema.field(i).optional{return Err("is_missing requires optional field".into());}Check::State(i,0)},
        Predicate::IsNull{field}=>{let i=schema.index(field)?;if !schema.field(i).nullable{return Err("is_null requires nullable field".into());}Check::State(i,1)},
        Predicate::IsValue{field}=>Check::State(schema.index(field)?,2),
        Predicate::And{clauses}|Predicate::Or{clauses}=>{if clauses.is_empty()||clauses.len()>64{return Err("Boolean clause bound".into());}let c=clauses.iter().map(|x|compile_profile(schema,x,depth+1,nodes,profile)).collect::<Result<Vec<_>,_>>()?;if matches!(p,Predicate::And{..}){Check::And(c)}else{Check::Or(c)}},
        Predicate::Not{clause}=>Check::Not(Box::new(compile_profile(schema,clause,depth+1,nodes,profile)?)),
    })
}
#[derive(Clone)]
struct Compiled {profile:Option<SemanticProfile>,select:Vec<usize>,predicate:Option<Check>,order:Vec<(usize,Direction)>}
impl Compiled {
    fn new(s:&Schema,q:&Query)->Result<Self,String>{
        let selection=q.select.as_ref().ok_or("raw select required")?;if q.global.is_some()||q.having.is_some()||q.group_by.is_some()||q.aggregates.is_some(){return Err("raw grouped options".into())}if selection.is_empty()||selection.len()>64||q.order_by.len()>8{return Err("selection/order bound".into());}
        let mut seen=BTreeSet::new();let mut select=Vec::new();for f in selection {if !seen.insert(f){return Err("duplicate selection".into());}select.push(s.index(f)?);}
        seen.clear();let mut order=Vec::new();for o in &q.order_by{let field=o.field.as_ref().ok_or("raw sort field required")?;if o.aggregate.is_some()||!seen.insert(field){return Err("invalid/duplicate ordering field".into());}order.push((s.index(field)?,o.direction));}
        let predicate=q.predicate.as_ref().map(|p|compile_profile(s,p,0,&mut 0,q.semantic_profile)).transpose()?;
        Ok(Self{profile:q.semantic_profile,select,predicate,order})
    }
    fn matches(&self,r:&Row)->bool {self.predicate.as_ref().is_none_or(|p|p.matches(r))}
    fn order(&self,r:&Row)->String {
        let mut out=String::new();
        for (i,d) in &self.order {
            append_order(&mut out,&sort_token(&r.cells[*i],self.profile,false),*d);
        }
        out
    }
}
pub(crate) fn append_order(out:&mut String,t:&str,d:Direction){
 let mut x=String::with_capacity(t.len()*2+1);for b in t.bytes(){use std::fmt::Write;write!(&mut x,"{b:02x}").unwrap();}x.push('/');
 if matches!(d,Direction::Desc){out.extend(x.bytes().map(|b|char::from(158-b)));}else{out.push_str(&x);}
}
struct Shape {topic:String,query:Compiled,grouped:Option<crate::grouped::Grouped>,index:RankedRows,references:usize}
struct Relation {schema:Schema,rows:BTreeMap<String,Row>,version:u64,max_rows:usize}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub enum Mutation {Upsert{row:Value},Delete{key:String}}
#[derive(Clone,Debug,Serialize)]
pub struct ResultRows {pub topic:String,pub schema:String,pub version:String,pub total_rows:usize,pub keys:Vec<String>,pub rows:Vec<Value>,pub projection:Vec<String>,#[serde(skip_serializing_if="Option::is_none")]pub result_shape:Option<String>}
pub struct Runtime {joins:BTreeMap<String,crate::join::JoinState>,join_subscriptions:BTreeMap<String,String>,catalog:Catalog,relations:BTreeMap<String,Relation>,engine:MembershipEngine,shapes:BTreeMap<u64,Shape>,identities:BTreeMap<String,u64>,subscriptions:BTreeMap<String,u64>,next_shape:u64,failed:bool,seed_rows:u64,changed_rows:u64,groups_touched:u64}
impl Runtime {
    pub fn new(catalog:Catalog,max_rows_per_topic:usize)->Result<Self,String>{
        if max_rows_per_topic==0||max_rows_per_topic>10_000_000{return Err("retained row resource bound".into());}
        let relations=catalog.topics().map(|(t,s)|(t.into(),Relation{schema:s.clone(),rows:BTreeMap::new(),version:0,max_rows:max_rows_per_topic})).collect();
        Ok(Self{joins:BTreeMap::new(),join_subscriptions:BTreeMap::new(),catalog,relations,engine:MembershipEngine::new(),shapes:BTreeMap::new(),identities:BTreeMap::new(),subscriptions:BTreeMap::new(),next_shape:0,failed:false,seed_rows:0,changed_rows:0,groups_touched:0})
    }
    pub fn metrics(&self)->Value{let values=self.shapes.values().filter_map(|s|s.grouped.as_ref()).map(|g|g.metrics()).collect::<Vec<_>>();serde_json::json!({"join_shapes":self.joins.len(),"join_touched":self.joins.values().map(|j|j.touched).sum::<u64>(),"join_seed_rows":self.joins.values().map(|j|j.seed_rows).sum::<u64>(),"shapes":self.shapes.len(),"seed_rows":self.seed_rows,"changed_rows":self.changed_rows,"groups_touched":self.groups_touched,"groups":values.iter().map(|v|v.0).sum::<usize>(),"retained_values":values.iter().map(|v|v.1).sum::<usize>(),"contributions_visited":values.iter().map(|v|v.2).sum::<u64>()})}
    pub fn catalog(&self)->&Catalog{&self.catalog}
    pub fn terminal(&self)->bool{self.failed}
    pub fn row_count(&self)->usize{self.relations.values().map(|r|r.rows.len()).sum()}
    fn safe(&self)->Result<(),String>{if self.failed{Err("terminal generic engine".into())}else{Ok(())}}
    fn complete(&mut self)->Result<(),String>{
        let done=match self.engine.complete(){Ok(v)=>v,Err(e)=>{self.failed=true;return Err(e)}};
        for c in done.changes {let Some(s)=self.shapes.get_mut(&c.shape)else{self.failed=true;return Err("unknown completed membership shape".into())};let row=RankedRow{id:c.id,payload:String::new(),sort_key:c.order};let valid=match c.weight{-1=>s.index.remove(&row,SortDirection::Ascending),1=>s.index.insert(row,SortDirection::Ascending),_=>false};if !valid{self.failed=true;return Err("invalid completed membership delta".into());}}
        Ok(())
    }
    pub fn open(&mut self,subscription:&str,topic:&str,fingerprint:&str,query:Query)->Result<(),String>{
        self.safe()?;if !valid_key(subscription){return Err("subscription identity bound".into());}
        let schema=self.catalog.schema(topic,fingerprint)?;
        if query.global.is_some()&&query.global!=Some(true){return Err("global must be true".into())}
        if query.global.is_some()&&query.group_by.is_some(){return Err("global/group_by mutually exclusive".into())}
        let mut grouped=if query.global==Some(true)||query.group_by.is_some(){if query.select.is_some(){return Err("aggregate select forbidden".into())}Some(crate::grouped::Grouped::with_options(topic,schema,query.group_by.as_deref().unwrap_or(&[]),query.aggregates.as_ref().ok_or("aggregates required")?,&query.order_by,query.global==Some(true),query.having.as_ref(),query.semantic_profile)?)}else{None};
        let compiled=if grouped.is_some(){Compiled{profile:query.semantic_profile,select:vec![],predicate:query.predicate.as_ref().map(|p|compile_profile(schema,p,0,&mut 0,query.semantic_profile)).transpose()?,order:vec![]}}else{Compiled::new(schema,&query)?};
        let identity=serde_json::to_string(&(topic,fingerprint,&query)).map_err(|e|e.to_string())?;
        if identity.len()>65_536{return Err("query byte bound".into());}
        if !self.subscriptions.contains_key(subscription)&&!self.join_subscriptions.contains_key(subscription)&&self.subscriptions.len()+self.join_subscriptions.len()>=257{return Err("subscription quota".into());}
        let shape=if let Some(s)=self.identities.get(&identity){*s}else{
            if self.shapes.len()>=257{return Err("shape quota".into());}
            self.seed_rows+=self.relations[topic].rows.len()as u64;self.next_shape=self.next_shape.checked_add(1).ok_or("shape identity exhausted")?;let id=self.next_shape;
            let changes=if let Some(g)=&mut grouped{g.update(self.relations[topic].rows.values().filter(|r|compiled.matches(r)).map(|r|(r,1)))?.into_iter().filter_map(|c|c.new.map(|order|MembershipChange{shape:id,id:c.id,order,weight:1})).collect::<Vec<_>>()}else{self.relations[topic].rows.values().filter(|r|compiled.matches(r)).map(|r|MembershipChange{shape:id,id:r.key.clone(),order:compiled.order(r),weight:1}).collect::<Vec<_>>()};
            self.shapes.insert(id,Shape{topic:topic.into(),query:compiled,grouped,index:RankedRows::default(),references:0});self.engine.apply_batch(changes);self.complete()?;self.identities.insert(identity,id);id
        };
        if self.subscriptions.get(subscription)==Some(&shape){return Ok(());}
        self.close(subscription)?;
        self.shapes.get_mut(&shape).unwrap().references+=1;self.subscriptions.insert(subscription.into(),shape);Ok(())
    }
    pub fn close(&mut self,subscription:&str)->Result<(),String>{
        self.safe()?;if let Some(key)=self.join_subscriptions.remove(subscription){let join=self.joins.get_mut(&key).unwrap();join.close(subscription)?;join.references-=1;if join.references==0{self.joins.remove(&key);}return Ok(())}if let Some(id)=self.subscriptions.remove(subscription){let shape=self.shapes.get_mut(&id).unwrap();shape.references-=1;if shape.references==0{let changes=shape.index.window(0,shape.index.len()).into_iter().map(|r|MembershipChange{shape:id,id:r.id,order:r.sort_key,weight:-1}).collect::<Vec<_>>();self.engine.apply_batch(changes);self.complete()?;self.shapes.remove(&id);self.identities.retain(|_,v|*v!=id);}}Ok(())
    }
    /// Call ONLY after canonical commit outcome is certain; this is derived state,
    /// never a durability or source-offset authority. The whole batch prevalidates.
    pub fn apply_committed(&mut self,topic:&str,fingerprint:&str,mutations:&[Mutation])->Result<u64,String>{
        self.safe()?;let schema=self.catalog.schema(topic,fingerprint)?;
        if mutations.is_empty()||mutations.len()>1024{return Err("mutation batch bound".into());}
        let relation=&self.relations[topic];let version=relation.version.checked_add(1).ok_or("relation version exhausted")?;
        let mut staged=BTreeMap::new();for m in mutations {match m{Mutation::Upsert{row}=>{let r=schema.row(row)?;staged.insert(r.key.clone(),Some(r));},Mutation::Delete{key}=>{if !schema.valid_identity(key){return Err("invalid delete key".into());}staged.insert(key.clone(),None);}}}
        let mut count=relation.rows.len();for (key,next) in &staged {if relation.rows.contains_key(key){count-=1;}if next.is_some(){count+=1;}}
        if count>relation.max_rows{return Err("retained row resource quota".into());}
        let mut changes=Vec::new();
        for (id,shape) in &mut self.shapes {if shape.topic!=topic{continue;}self.changed_rows+=staged.len()as u64;
            if let Some(g)=&mut shape.grouped{if g.error.is_some(){continue}let rows=staged.iter().filter_map(|(key,_)|relation.rows.get(key).filter(|r|shape.query.matches(r))).map(|r|(r,-1)).chain(staged.values().filter_map(|r|r.as_ref().filter(|r|shape.query.matches(r))).map(|r|(r,1)));match g.update(rows){Ok(delta)=>{self.groups_touched+=delta.len()as u64;for c in delta{if let Some(order)=c.old{changes.push(MembershipChange{shape:*id,id:c.id.clone(),order,weight:-1})}if let Some(order)=c.new{changes.push(MembershipChange{shape:*id,id:c.id,order,weight:1})}}},Err(e)=>g.error=Some(e)}continue;}
            for (key,next) in &staged {
            if let Some(old)=relation.rows.get(key).filter(|r|shape.query.matches(r)){changes.push(MembershipChange{shape:*id,id:key.clone(),order:shape.query.order(old),weight:-1});}
            if let Some(new)=next.as_ref().filter(|r|shape.query.matches(r)){changes.push(MembershipChange{shape:*id,id:key.clone(),order:shape.query.order(new),weight:1});}
        }}
        self.engine.apply_batch(changes);self.complete()?;
        let changed=staged.keys().cloned().collect::<Vec<_>>();let relation=self.relations.get_mut(topic).unwrap();for (key,row) in staged{if let Some(row)=row{relation.rows.insert(key,row);}else{relation.rows.remove(&key);}}relation.version=version;
        for join in self.joins.values_mut(){if join.error.is_some()||topic!=join.left&&topic!=join.definition.right.topic{continue}if let Err(e)=join.update(topic,&changed,&self.relations[&join.left].rows,&self.relations[&join.definition.right.topic].rows){join.error=Some(e);}}Ok(version)
    }
    pub fn read(&self,subscription:&str,offset:usize,limit:usize,max_bytes:usize)->Result<ResultRows,String>{
        self.safe()?;if let Some(key)=self.join_subscriptions.get(subscription){return self.joins[key].read(subscription,offset,limit,max_bytes)}if limit>4096||offset.checked_add(limit).is_none()||max_bytes==0||max_bytes>4*1024*1024{return Err("window/output bound".into());}
        let id=self.subscriptions.get(subscription).ok_or("unknown subscription")?;let shape=&self.shapes[id];let relation=&self.relations[&shape.topic];let selected=shape.index.window(offset,limit);
        if let Some(error)=shape.grouped.as_ref().and_then(|g|g.error.as_ref()){return Err(error.clone())}
        let keys=selected.iter().map(|r|r.id.clone()).collect();let rows=selected.iter().map(|r|if let Some(g)=&shape.grouped{g.row(&r.id).clone()}else{relation.schema.project(&relation.rows[&r.id],&shape.query.select)}).collect();
        let projection=shape.grouped.as_ref().map_or_else(||shape.query.select.iter().map(|i|relation.schema.definition().fields[*i].name.clone()).collect(),|g|g.projection.clone());let result_shape=shape.grouped.as_ref().map(|g|g.shape.clone());
        let result=ResultRows{topic:shape.topic.clone(),schema:relation.schema.fingerprint().into(),version:relation.version.to_string(),total_rows:shape.index.len(),keys,rows,projection,result_shape};
        if serde_json::to_vec(&result).map_err(|e|e.to_string())?.len()>max_bytes{return Err("projected result byte bound".into());}Ok(result)
    }
    pub fn open_join(&mut self,subscription:&str,topic:&str,fingerprint:&str,join:crate::join::JoinDefinition,query:Query)->Result<(),String>{
        self.safe()?;if !valid_key(subscription){return Err("subscription identity bound".into())}
        if !self.subscriptions.contains_key(subscription)&&!self.join_subscriptions.contains_key(subscription)&&self.subscriptions.len()+self.join_subscriptions.len()>=257{return Err("subscription quota".into())}
        let left=self.catalog.schema(topic,fingerprint)?;let right=self.catalog.schema(&join.right.topic,&join.right.schema)?;let key=crate::join::JoinState::signature(topic,fingerprint,&join);
        if self.join_subscriptions.get(subscription)==Some(&key){return self.joins.get_mut(&key).unwrap().open(subscription,query)}
        if let Some(state)=self.joins.get_mut(&key){state.open(subscription,query)?;}else{
            if self.joins.len()>=32{return Err("join shape quota".into())}
            let mut state=crate::join::JoinState::new(topic,left,right,join.clone(),&self.relations[topic].rows,&self.relations[&join.right.topic].rows,self.relations[topic].max_rows)?;state.open(subscription,query)?;self.joins.insert(key.clone(),state);
        }
        self.close(subscription)?;self.joins.get_mut(&key).unwrap().references+=1;self.join_subscriptions.insert(subscription.into(),key);Ok(())
    }
    pub fn rows(&self,topic:&str,fingerprint:&str)->Result<Vec<Value>,String>{self.safe()?;self.catalog.schema(topic,fingerprint)?;let r=&self.relations[topic];Ok(r.rows.values().map(|row|r.schema.full(row)).collect())}
}

#[cfg(test)]mod tests {
    use super::*;use crate::schema::{Definition,Manifest,Topic,Field};use serde_json::json;
    fn catalog()->Catalog{let s=Schema::new(Definition{expansion:None,format:1,id:"orders".into(),version:1,key:"id".into(),fields:vec![Field{name:"id".into(),kind:Kind::String,optional:false,nullable:false},Field{name:"price".into(),kind:Kind::Decimal,optional:false,nullable:false},Field{name:"active".into(),kind:Kind::Boolean,optional:false,nullable:false}]}).unwrap();let p=Schema::new(Definition{expansion:None,format:1,id:"positions".into(),version:1,key:"id".into(),fields:vec![Field{name:"id".into(),kind:Kind::String,optional:false,nullable:false},Field{name:"symbol".into(),kind:Kind::String,optional:false,nullable:false},Field{name:"quantity".into(),kind:Kind::Uint64,optional:false,nullable:false}]}).unwrap();Catalog::new(Manifest{format:1,schemas:vec![s.definition().clone(),p.definition().clone()],topics:vec![Topic{topic:"orders".into(),schema:s.fingerprint().into()},Topic{topic:"positions".into(),schema:p.fingerprint().into()}]}).unwrap()}
    fn query()->Query{serde_json::from_value(json!({"select":["price"],"where":{"op":"eq","field":"active","value":true},"order_by":[{"field":"price","direction":"asc"}]})).unwrap()}
    #[test]fn two_real_schemas_one_runtime_isolated_and_incremental(){let c=catalog();let fingerprints=c.topics().map(|(t,s)|(t.to_string(),s.fingerprint().to_string())).collect::<BTreeMap<_,_>>();let o=&fingerprints["orders"];let p=&fingerprints["positions"];let mut r=Runtime::new(c,100).unwrap();r.apply_committed("orders",o,&[Mutation::Upsert{row:json!({"id":"same","price":"10","active":true})},Mutation::Upsert{row:json!({"id":"a","price":"2","active":true})}]).unwrap();r.apply_committed("positions",p,&[Mutation::Upsert{row:json!({"id":"same","symbol":"XYZ","quantity":"18446744073709551615"})}]).unwrap();r.open("o","orders",o,query()).unwrap();let pq=serde_json::from_value(json!({"select":["symbol","quantity"],"order_by":[{"field":"quantity","direction":"desc"}]})).unwrap();r.open("p","positions",p,pq).unwrap();assert_eq!(r.read("o",0,10,65536).unwrap().keys,vec!["a","same"]);assert_eq!(r.read("p",0,1,65536).unwrap().rows,vec![json!({"symbol":"XYZ","quantity":"18446744073709551615"})]);r.apply_committed("orders",o,&[Mutation::Upsert{row:json!({"id":"same","price":"1","active":true})},Mutation::Delete{key:"a".into()}]).unwrap();assert_eq!(r.read("o",0,1,65536).unwrap().rows,vec![json!({"price":"1"})]);assert_eq!(r.read("p",0,1,65536).unwrap().total_rows,1);assert!(r.open("o","positions",p,query()).is_err());assert_eq!(r.read("o",0,1,65536).unwrap().topic,"orders");}
    #[test]fn multi_column_desc_prefix_ties_and_atomic_invalid_batch(){let c=catalog();let fp=c.topics().find(|(t,_)|*t=="orders").unwrap().1.fingerprint().to_string();let mut r=Runtime::new(c,100).unwrap();r.apply_committed("orders",&fp,&[Mutation::Upsert{row:json!({"id":"a","price":"1","active":true})},Mutation::Upsert{row:json!({"id":"ab","price":"1","active":true})},Mutation::Upsert{row:json!({"id":"b","price":"2","active":true})}]).unwrap();r.open("q","orders",&fp,serde_json::from_value(json!({"select":["id"],"order_by":[{"field":"price","direction":"asc"},{"field":"id","direction":"desc"}]})).unwrap()).unwrap();assert_eq!(r.read("q",0,10,65536).unwrap().keys,vec!["ab","a","b"]);assert!(r.apply_committed("orders",&fp,&[Mutation::Delete{key:"a".into()},Mutation::Upsert{row:json!({"id":"bad","price":4,"active":true})}]).is_err());assert_eq!(r.read("q",0,10,65536).unwrap().keys,vec!["ab","a","b"]);}
    #[test]fn third_wide_schema_needs_only_manifest(){let mut fields=vec![Field{name:"id".into(),kind:Kind::String,optional:false,nullable:false}];for i in 0..39{fields.push(Field{name:format!("column{i}"),kind:Kind::Number,optional:false,nullable:false});}let s=Schema::new(Definition{expansion:None,format:1,id:"wide".into(),version:1,key:"id".into(),fields}).unwrap();let fp=s.fingerprint().to_string();let c=Catalog::new(Manifest{format:1,schemas:vec![s.definition().clone()],topics:vec![Topic{topic:"quotes".into(),schema:fp.clone()}]}).unwrap();let mut r=Runtime::new(c,10).unwrap();let mut row=serde_json::Map::new();row.insert("id".into(),json!("a"));for i in 0..39{row.insert(format!("column{i}"),json!(i as f64+0.25));}r.apply_committed("quotes",&fp,&[Mutation::Upsert{row:Value::Object(row)}]).unwrap();r.open("q","quotes",&fp,serde_json::from_value(json!({"select":["column37"],"order_by":[]})).unwrap()).unwrap();assert_eq!(r.read("q",0,1,65536).unwrap().rows,vec![json!({"column37":37.25})]);}
}
