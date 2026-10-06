use crate::schema::Scalar;
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use unicode_general_category::{get_general_category,GeneralCategory};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SemanticProfile { #[serde(rename="effect-4.2.8")] Effect428 }

pub fn normalized(input:&str,case_sensitive:bool,accent_sensitive:bool)->String {
    let decomposed:String=input.nfd().filter(|c|accent_sensitive||!matches!(get_general_category(*c),GeneralCategory::NonspacingMark|GeneralCategory::SpacingMark|GeneralCategory::EnclosingMark)).collect();
    if case_sensitive {decomposed} else {decomposed.to_lowercase()}
}
pub fn sort_token(value:&Scalar,profile:Option<SemanticProfile>,aggregate:bool)->String {
    if profile.is_none(){return value.sort_token()}
    match value {
        Scalar::String(text)=>{let mut out=String::from("2");for unit in text.encode_utf16(){use std::fmt::Write;write!(&mut out,"{unit:04x}").unwrap();}out},
        Scalar::Null if !aggregate=>"0".into(),
        Scalar::Missing if !aggregate=>"1".into(),
        _=>value.sort_token(),
    }
}
