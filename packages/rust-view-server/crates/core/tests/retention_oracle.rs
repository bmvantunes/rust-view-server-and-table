//! A deliberately recomputing oracle for the effects of retention retractions.
//! It does not use the incremental aggregate implementation or its indexes.
use rust_differential_product_core::{
    generic::{Mutation,Runtime},
    schema::{Catalog,Definition,Field,Kind,Manifest,Schema,Topic},
};
use serde_json::{Value,json};
use std::collections::{BTreeMap,BTreeSet};

fn fixture()->(Catalog,String){
    let schema=Schema::new(Definition{expansion:None,format:1,id:"retention_oracle".into(),version:1,key:"id".into(),fields:vec![
        Field{name:"id".into(),kind:Kind::String,optional:false,nullable:false},
        Field{name:"desk".into(),kind:Kind::String,optional:false,nullable:false},
        Field{name:"amount".into(),kind:Kind::Decimal,optional:false,nullable:true},
        Field{name:"tag".into(),kind:Kind::String,optional:true,nullable:true},
    ]}).unwrap();
    let fingerprint=schema.fingerprint().to_string();
    let catalog=Catalog::new(Manifest{format:1,schemas:vec![schema.definition().clone()],topics:vec![Topic{topic:"orders".into(),schema:fingerprint.clone()}]}).unwrap();
    (catalog,fingerprint)
}

fn id_for_group(fingerprint:&str,desk:&str)->String{
    let bytes=serde_json::to_vec(&json!([1,"orders",fingerprint,[["desk","string",2,desk]]])).unwrap();
    format!("gid1:{}",bytes.iter().map(|b|format!("{b:02x}")).collect::<String>())
}

fn decimal_sum(total:i64)->String{total.to_string()}
fn decimal_average(total:i64,count:usize)->String{
    let numerator=(total as i128)*1_000_000_000_000_000_000i128;
    let denominator=count as i128;
    let mut quotient=numerator/denominator;
    let remainder=numerator%denominator;
    let twice=remainder.abs()*2;
    if twice>denominator || (twice==denominator && quotient%2!=0){quotient+=numerator.signum();}
    let negative=quotient<0;let digits=quotient.abs().to_string();
    let padded=format!("{:0>19}",digits);let split=padded.len()-18;
    let whole=&padded[..split];let fraction=padded[split..].trim_end_matches('0');
    let value=if fraction.is_empty(){whole.to_string()}else{format!("{whole}.{fraction}")};
    if negative && value!="0" {format!("-{value}")}else{value}
}

/// Rebuild every aggregate directly from the authored rows at each completed cut.
fn oracle(rows:&BTreeMap<String,Value>,fingerprint:&str)->Vec<(String,Value,i64)>{
    let mut groups=BTreeMap::<String,Vec<&Value>>::new();
    for row in rows.values(){groups.entry(row["desk"].as_str().unwrap().to_owned()).or_default().push(row);}
    let mut result=groups.into_iter().map(|(desk,members)|{
        let amounts=members.iter().filter_map(|row|row["amount"].as_str().map(|v|v.parse::<i64>().unwrap())).collect::<Vec<_>>();
        let sum=amounts.iter().sum::<i64>();
        let mut distinct=BTreeSet::new();
        for row in &members {
            distinct.insert(if !row.as_object().unwrap().contains_key("tag"){"missing".to_string()}else if row["tag"].is_null(){"null".to_string()}else{format!("value:{}",row["tag"].as_str().unwrap())});
        }
        let aggregate_row=json!({
            "desk":desk,
            "count":members.len().to_string(),
            "sum":json!(decimal_sum(sum)),
            "average":if amounts.is_empty(){Value::Null}else{json!(decimal_average(sum,amounts.len()))},
            "distinctTags":distinct.len().to_string(),
            "minimum":amounts.iter().min().map(|v|json!(v.to_string())).unwrap_or(Value::Null),
            "maximum":amounts.iter().max().map(|v|json!(v.to_string())).unwrap_or(Value::Null),
        });
        (id_for_group(fingerprint,&desk),aggregate_row,if amounts.is_empty(){i64::MIN}else{sum})
    }).collect::<Vec<_>>();
    result.sort_by(|a,b|b.2.cmp(&a.2).then_with(||a.0.cmp(&b.0)));
    result
}

fn assert_cut(runtime:&Runtime,rows:&BTreeMap<String,Value>,fingerprint:&str){
    let raw=runtime.read("raw",0,10,65536).unwrap();
    let expected_raw=rows.iter().map(|(_,row)|{
        let mut projected=serde_json::Map::new();
        for name in ["desk","amount","tag"] {if let Some(value)=row.get(name){projected.insert(name.into(),value.clone());}}
        Value::Object(projected)
    }).collect::<Vec<_>>();
    let expected_keys=rows.keys().cloned().collect::<Vec<_>>();
    assert_eq!(raw.total_rows,expected_keys.len());assert_eq!(raw.keys,expected_keys);assert_eq!(raw.rows,expected_raw);
    let raw_window=runtime.read("raw",1,2,65536).unwrap();
    assert_eq!(raw_window.keys,expected_keys.iter().skip(1).take(2).cloned().collect::<Vec<_>>());
    assert_eq!(raw_window.rows,expected_raw.iter().skip(1).take(2).cloned().collect::<Vec<_>>());

    let expected=oracle(rows,fingerprint);
    let grouped=runtime.read("grouped",0,10,65536).unwrap();
    assert_eq!(grouped.total_rows,expected.len());
    assert_eq!(grouped.keys,expected.iter().map(|(id,_,_)|id.clone()).collect::<Vec<_>>());
    assert_eq!(grouped.rows,expected.iter().map(|(_,row,_)|row.clone()).collect::<Vec<_>>());
    assert_eq!(grouped.projection,vec!["desk","average","count","distinctTags","maximum","minimum","sum"]);
    let first=runtime.read("grouped",0,1,65536).unwrap();
    assert_eq!(first.keys,expected.iter().take(1).map(|(id,_,_)|id.clone()).collect::<Vec<_>>());
    let second=runtime.read("grouped",1,1,65536).unwrap();
    assert_eq!(second.keys,expected.iter().skip(1).take(1).map(|(id,_,_)|id.clone()).collect::<Vec<_>>());
}

#[test]
fn raw_and_six_aggregate_views_match_recomputed_oracle_at_each_retention_cut(){
    let (catalog,fingerprint)=fixture();let mut runtime=Runtime::new(catalog,100).unwrap();
    let initial=vec![
        json!({"id":"n1","desk":"north","amount":"10","tag":"red"}),
        json!({"id":"n2","desk":"north","amount":"2","tag":null}),
        json!({"id":"n3","desk":"north","amount":null}),
        json!({"id":"s1","desk":"south","amount":"3","tag":"blue"}),
        json!({"id":"s2","desk":"south","amount":"8","tag":"blue"}),
    ];
    let mutations=initial.iter().cloned().map(|row|Mutation::Upsert{row}).collect::<Vec<_>>();
    runtime.apply_committed("orders",&fingerprint,&mutations).unwrap();
    runtime.open("raw","orders",&fingerprint,serde_json::from_value(json!({"select":["desk","amount","tag"],"order_by":[{"field":"id","direction":"asc"}]})).unwrap()).unwrap();
    runtime.open("grouped","orders",&fingerprint,serde_json::from_value(json!({
        "group_by":["desk"],"aggregates":{
            "count":{"aggFunc":"count"},"sum":{"aggFunc":"sum","field":"amount"},"average":{"aggFunc":"avg","field":"amount"},
            "distinctTags":{"aggFunc":"countDistinct","field":"tag"},"minimum":{"aggFunc":"min","field":"amount"},"maximum":{"aggFunc":"max","field":"amount"}
        },"order_by":[{"aggregate":"sum","direction":"desc"}]
    })).unwrap()).unwrap();
    let mut rows=initial.into_iter().map(|row|(row["id"].as_str().unwrap().to_owned(),row)).collect::<BTreeMap<_,_>>();
    let north_id=id_for_group(&fingerprint,"north");let south_id=id_for_group(&fingerprint,"south");
    let check=|runtime:&Runtime,rows:&BTreeMap<String,Value>|assert_cut(runtime,rows,&fingerprint);
    check(&runtime,&rows);
    for id in ["n1","n2","s1","n3","s2"] {
        runtime.apply_committed("orders",&fingerprint,&[Mutation::Delete{key:id.into()}]).unwrap();rows.remove(id);
        check(&runtime,&rows);
        if rows.keys().any(|key|key.starts_with('n')){assert!(runtime.read("grouped",0,10,65536).unwrap().keys.contains(&north_id));}
        if rows.keys().any(|key|key.starts_with('s')){assert!(runtime.read("grouped",0,10,65536).unwrap().keys.contains(&south_id));}
    }
    assert!(runtime.read("grouped",0,10,65536).unwrap().keys.is_empty());
}
