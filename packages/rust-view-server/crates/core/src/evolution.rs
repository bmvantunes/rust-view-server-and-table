//! One append-only optional-leaf compatibility policy. No fingerprint aliases.
use crate::schema::Schema;
pub fn optional_addition(old:&Schema,new:&Schema)->Result<(),String>{
 let a=old.definition();let b=new.definition();
 if !matches!(a.format,2|3)||a.format!=b.format||a.version!=b.version||a.id!=b.id||a.key!=b.key||b.fields.len()<=a.fields.len()||!b.fields.starts_with(&a.fields){return Err("evolution requires unchanged schema identity and append-only fields".into())}
 if b.fields[a.fields.len()..].iter().any(|f|!f.optional){return Err("evolution added fields must be explicitly optional".into())}
 match(&a.expansion,&b.expansion){
  (None,None)=>{},
  (Some(x),Some(y))if x.message==y.message&&x.parents==y.parents&&x.enums==y.enums&&y.leaves.starts_with(&x.leaves)&&y.leaves[x.leaves.len()..].iter().all(|l|l.presence=="explicit"&&!l.required)=>{},
  _=>return Err("evolution changes parent/enum/presence metadata".into())
 }
 Ok(())
}
#[cfg(test)]mod tests{
 use super::*;use crate::schema::{Definition,Field,Kind};
 fn old()->Schema{Schema::new(Definition{format:2,id:"rows_v2".into(),version:2,key:"rowId".into(),fields:vec![Field{name:"name".into(),kind:Kind::String,optional:false,nullable:false}],expansion:None}).unwrap()}
 #[test]fn optional_only_and_exact_old_fields(){let a=old();let mut d=a.definition().clone();d.fields.push(Field{name:"memo".into(),kind:Kind::String,optional:true,nullable:true});let b=Schema::new(d.clone()).unwrap();assert!(optional_addition(&a,&b).is_ok());d.fields[1].optional=false;assert!(optional_addition(&a,&Schema::new(d.clone()).unwrap()).is_err());d.fields[1].optional=true;d.fields[0].nullable=true;assert!(optional_addition(&a,&Schema::new(d).unwrap()).is_err());assert!(optional_addition(&a,&a).is_err());assert!(optional_addition(&b,&a).is_err());}
}
