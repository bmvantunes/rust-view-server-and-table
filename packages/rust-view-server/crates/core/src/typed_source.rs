//! Shared typed source admission for decoded native values and local publishers.
//! Both paths enter this exact schema, identity and mutation boundary.
use crate::{generic::Mutation, schema::{Definition, Field, Kind, Schema, Scalar, encode_row_id, path_get, valid_name}};
use serde::{Deserialize,Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone,Copy,Debug,Eq,PartialEq,Serialize,Deserialize)]
pub enum SourcePolicy {#[serde(rename="delete")]Delete,#[serde(rename="compact")]Compact,#[serde(rename="compact,delete")]CompactDelete}
impl SourcePolicy {
    pub fn has_delete(self)->bool{matches!(self,Self::Delete|Self::CompactDelete)}
    pub fn validate_actual(self,actual:&str)->Result<(),String>{
        let parts=actual.split(',').map(str::trim).collect::<BTreeSet<_>>();
        let expected=match self {Self::Delete=>BTreeSet::from(["delete"]),Self::Compact=>BTreeSet::from(["compact"]),Self::CompactDelete=>BTreeSet::from(["compact","delete"])};
        if parts!=expected||parts.len()!=actual.split(',').count(){return Err(format!("configured source identity policy {self:?} differs from actual cleanup.policy {actual}"));}Ok(())
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyField { pub name: String, pub tag: u32, pub kind: Kind }
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Component { pub source: String, pub field: String }
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity { pub source_policy: SourcePolicy, pub components: Vec<Component> }
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceDefinition {
    #[serde(rename = "keyFields")]
    pub key_fields: Vec<KeyField>,
    pub identity: Identity,
}
#[derive(Clone)]
pub struct TypedSource { schema: Schema, key_schema: Schema, definition: SourceDefinition }
impl TypedSource {
    pub fn new(schema: Schema, definition: SourceDefinition) -> Result<Self, String> {
        if schema.definition().format < 2 { return Err("typed sources require authoritative rowId schema".into()); }
        let fields = &definition.key_fields;
        if fields.is_empty() || fields.len() > 64 { return Err("key field bound".into()); }
        let mut tags = BTreeSet::new();
        let mut names = BTreeSet::new();
        for field in fields {
            if !valid_name(&field.name) || field.name == "rowId" || field.tag == 0 || field.tag > 536870911 || (19000..=19999).contains(&field.tag) || !tags.insert(field.tag) || !names.insert(field.name.clone()) || field.kind == Kind::Enum {
                return Err("invalid key field".into());
            }
        }
        let identity = &definition.identity;
        if identity.components.is_empty() || identity.components.len() > 16 { return Err("identity policy/components".into()); }
        let mut components = BTreeSet::new();
        for component in &identity.components {
            if !components.insert((component.source.clone(),component.field.clone())) { return Err("duplicate identity component".into()); }
            match component.source.as_str() {
                "key" if names.contains(&component.field) => {},
                "value" if identity.source_policy == SourcePolicy::Delete => {
                    let field = schema.field(&component.field)?;
                    if field.optional || field.nullable || field.kind == Kind::Enum { return Err("identity value field must be required non-null scalar".into()); }
                },
                _ => return Err("unknown identity component or compact value identity".into()),
            }
        }
        let key_schema = Schema::new(Definition { format: 2, id: "identity_key".into(), version: 2, key: "rowId".into(), expansion: None, fields: fields.iter().map(|f|Field {name:f.name.clone(),kind:f.kind,optional:false,nullable:false}).collect() })?;
        Ok(Self { schema, key_schema, definition })
    }
    pub fn admit(&self, key: &Value, value: Option<&Value>) -> Result<Mutation, String> {
        let key = key.as_object().ok_or("key object required")?;
        if key.len() != self.definition.key_fields.len() { return Err("key must contain exactly generated fields".into()); }
        let mut keys: BTreeMap<String, Scalar> = BTreeMap::new();
        for (i, field) in self.definition.key_fields.iter().enumerate() {
            keys.insert(field.name.clone(),self.key_schema.scalar(i,key.get(&field.name).ok_or("missing key field")?)?);
        }
        let components = self.definition.identity.components.iter().map(|component| {
            if component.source == "key" { keys.get(&component.field).cloned().ok_or_else(||"missing identity key component".into()) }
            else {
                let value = value.ok_or("value-derived delete identity cannot admit key-only tombstone")?;
                self.schema.scalar(self.schema.index(&component.field)?,path_get(value,&component.field).ok_or("missing identity value component")?)
            }
        }).collect::<Result<Vec<_>,String>>()?;
        let row_id = encode_row_id(&components)?;
        match value {
            None => Ok(Mutation::Delete { key: row_id }),
            Some(value) => {
                let mut row = value.as_object().ok_or("value object required")?.clone();
                if row.contains_key("rowId") { return Err("rowId is source-owned, not a publish input".into()); }
                row.insert("rowId".into(),Value::String(row_id));
                let admitted = self.schema.row(&Value::Object(row))?;
                Ok(Mutation::Upsert { row: self.schema.full(&admitted) })
            }
        }
    }
}
