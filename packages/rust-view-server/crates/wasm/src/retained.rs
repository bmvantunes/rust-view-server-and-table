//! Fixture-only index scheduling the shared production retention policy.
//! Its clock and rows belong to one LocalEngine; it has no timer or persistence.
use std::collections::{BTreeMap,BTreeSet};
use rust_differential_product_core::retention::{NormalizedRetention,CountScope,expiry_ms};

#[derive(Clone)]
struct Row { source:String, order:u64, expiry:Option<u64> }
pub struct Retained {
    pub policy:NormalizedRetention,
    rows:BTreeMap<String,Row>, recency:BTreeSet<(u64,String)>,
    per_key:BTreeMap<String,BTreeSet<(u64,String)>>, expiry:BTreeSet<(u64,String)>, next:u64,
}
impl Retained {
    pub fn new(policy:NormalizedRetention)->Self {Self{policy,rows:BTreeMap::new(),recency:BTreeSet::new(),per_key:BTreeMap::new(),expiry:BTreeSet::new(),next:0}}
    pub fn prepare(&self,id:&str,source:&str,now:u64)->Result<Vec<String>,String> {
        self.next.checked_add(1).ok_or("retention order exhausted")?;
        if let Some(age)=self.policy.max_age_ms {expiry_ms(now,age)?;}
        let Some(limit)=self.policy.max_messages else{return Ok(vec![])};
        let selected=match self.policy.count_scope{Some(CountScope::WholeTopic)=>Some(&self.recency),Some(CountScope::PerSourceKey)=>self.per_key.get(source),None=>None};
        let Some(selected)=selected else{return Ok(vec![])};
        let existing=selected.iter().filter(|(_,key)|key!=id);
        let old=self.rows.get(id);
        let included=old.is_some_and(|row|self.policy.count_scope==Some(CountScope::WholeTopic)||row.source==source);
        let count=selected.len()-usize::from(included);
        Ok(existing.take((count+1).saturating_sub(limit as usize)).map(|(_,key)|key.clone()).collect())
    }
    pub fn remove(&mut self,id:&str) {
        if let Some(old)=self.rows.remove(id) {
            self.recency.remove(&(old.order,id.to_owned()));
            if let Some(keys)=self.per_key.get_mut(&old.source){keys.remove(&(old.order,id.to_owned()));if keys.is_empty(){self.per_key.remove(&old.source);}}
            if let Some(expiry)=old.expiry{self.expiry.remove(&(expiry,id.to_owned()));}
        }
    }
    pub fn insert(&mut self,id:String,source:String,now:u64) {
        self.remove(&id);self.next+=1;
        let expiry=self.policy.max_age_ms.map(|age|expiry_ms(now,age).expect("prevalidated expiry"));
        self.recency.insert((self.next,id.clone()));self.per_key.entry(source.clone()).or_default().insert((self.next,id.clone()));
        if let Some(expiry)=expiry{self.expiry.insert((expiry,id.clone()));}
        self.rows.insert(id,Row{source,order:self.next,expiry});
    }
    pub fn due(&self,now:u64)->Vec<String>{self.expiry.iter().take_while(|(expiry,_)|*expiry<=now).take(1024).map(|(_,id)|id.clone()).collect()}
}
