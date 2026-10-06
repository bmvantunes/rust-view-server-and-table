//! Typed application-side per-topic retention policy and shared operational bounds.
//! Kafka's source log remains independently governed by its broker policy.

use crate::typed_source::SourcePolicy;
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const MAX_RETENTION_MINUTES: f64 = 5_256_000.0; // ten years
pub const MAX_RETENTION_ROWS: u64 = 10_000_000;
pub const MAX_FUTURE_TIMESTAMP_SKEW_MS: u64 = 300_000;
pub const MAINTENANCE_INTERVAL_MS: u64 = 250;
pub const MAINTENANCE_BATCH_ROWS: usize = 256;
pub const MAINTENANCE_BATCH_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionPolicy {
    #[serde(default, deserialize_with = "crate::generic::non_null_option", skip_serializing_if = "Option::is_none")]
    pub max_retention_minutes: Option<f64>,
    #[serde(default, deserialize_with = "crate::generic::non_null_option", skip_serializing_if = "Option::is_none")]
    pub max_retention_messages: Option<u64>,
    #[serde(default, deserialize_with = "crate::generic::non_null_option", skip_serializing_if = "Option::is_none")]
    pub max_retention_messages_per_key: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CountScope {
    WholeTopic,
    PerSourceKey,
}

/// The canonical-format-bound, millisecond/integer form of the user policy.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NormalizedRetention {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_age_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_messages: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count_scope: Option<CountScope>,
}

impl RetentionPolicy {
    pub fn normalize(
        &self,
        source_policy: SourcePolicy,
        max_rows: usize,
    ) -> Result<NormalizedRetention, String> {
        let has_topic = self.max_retention_messages.is_some();
        let has_key = self.max_retention_messages_per_key.is_some();
        if has_topic && has_key {
            return Err("maxRetentionMessages and maxRetentionMessagesPerKey are mutually exclusive".into());
        }
        if self.max_retention_minutes.is_none() && !has_topic && !has_key {
            return Err("retention policy must set at least one maximum".into());
        }
        let max_age_ms = self.max_retention_minutes.map(minutes_to_ms).transpose()?;
        let (max_messages, count_scope) = if let Some(count) = self.max_retention_messages {
            validate_count(count, max_rows)?;
            if source_policy != SourcePolicy::Delete {
                return Err("maxRetentionMessages requires source cleanupPolicy=delete".into());
            }
            (Some(count), Some(CountScope::WholeTopic))
        } else if let Some(count) = self.max_retention_messages_per_key {
            validate_count(count, max_rows)?;
            if source_policy == SourcePolicy::Delete {
                return Err("maxRetentionMessagesPerKey requires source cleanupPolicy=compact or compact,delete".into());
            }
            (Some(count), Some(CountScope::PerSourceKey))
        } else {
            (None, None)
        };
        Ok(NormalizedRetention { max_age_ms, max_messages, count_scope })
    }
}

fn validate_count(value: u64, max_rows: usize) -> Result<(), String> {
    if value == 0 || value > MAX_RETENTION_ROWS || value > max_rows as u64 {
        return Err(format!("retention count must be positive and no greater than min(maxRows, {MAX_RETENTION_ROWS})"));
    }
    Ok(())
}

pub fn minutes_to_ms(minutes: f64) -> Result<u64, String> {
    if !minutes.is_finite() || minutes <= 0.0 || minutes > MAX_RETENTION_MINUTES {
        return Err(format!("maxRetentionMinutes must be finite, positive, and at most {MAX_RETENTION_MINUTES}"));
    }
    let seconds = minutes * 60.0;
    if !seconds.is_finite() {
        return Err("retention duration overflow".into());
    }
    let duration = Duration::try_from_secs_f64(seconds).map_err(|_| "retention duration overflow")?;
    // Kafka timestamps and the owner reference clock have millisecond precision.
    // Ceiling conversion ensures rounding never expires a row earlier than requested.
    let whole = duration.as_millis();
    let rounded = whole
        .checked_add(u128::from(duration.subsec_nanos() % 1_000_000 != 0))
        .ok_or("retention duration overflow")?;
    let millis = u64::try_from(rounded).map_err(|_| "retention duration overflow")?;
    if millis == 0 {
        return Err("maxRetentionMinutes converts to less than one millisecond".into());
    }
    Ok(millis)
}

pub fn expiry_ms(origin_ms: u64, max_age_ms: u64) -> Result<u64, String> {
    origin_ms.checked_add(max_age_ms).ok_or_else(|| "retention expiry timestamp overflow".into())
}

pub fn format_duration_ms(ms: u64) -> String {
    if ms % 3_600_000 == 0 {
        let hours = ms / 3_600_000;
        return format!("{hours} {}", if hours == 1 { "hour" } else { "hours" });
    }
    if ms % 60_000 == 0 {
        let minutes = ms / 60_000;
        return format!("{minutes} {}", if minutes == 1 { "minute" } else { "minutes" });
    }
    format!("{ms} ms")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn age_conversion_is_checked_and_ceil_millisecond() {
        assert_eq!(minutes_to_ms(1440.0).unwrap(), 86_400_000);
        assert_eq!(format_duration_ms(86_400_000), "24 hours");
        assert_eq!(minutes_to_ms(0.00001).unwrap(), 1);
        for value in [0.0, -1.0, f64::NAN, f64::INFINITY, MAX_RETENTION_MINUTES + 1.0] {
            assert!(minutes_to_ms(value).is_err());
        }
    }

    #[test]
    fn native_config_rejects_wrong_branch_fractional_counts_and_empty_policy() {
        let parse = |v| serde_json::from_value::<RetentionPolicy>(v);
        let wrong_global: RetentionPolicy = parse(json!({"maxRetentionMessages":2})).unwrap();
        assert!(wrong_global.normalize(SourcePolicy::Compact, 10).is_err());
        let wrong_key: RetentionPolicy = parse(json!({"maxRetentionMessagesPerKey":2})).unwrap();
        assert!(wrong_key.normalize(SourcePolicy::Delete, 10).is_err());
        assert!(parse(json!({"maxRetentionMessages":1.5})).is_err());
        let empty: RetentionPolicy = parse(json!({})).unwrap();
        assert!(empty.normalize(SourcePolicy::Delete, 10).is_err());
        let both: RetentionPolicy = parse(json!({"maxRetentionMessages":2,"maxRetentionMessagesPerKey":2})).unwrap();
        assert!(both.normalize(SourcePolicy::Delete, 10).is_err());
    }

    #[test]
    fn policy_normalizes_scope_and_bounds_counts_to_owner_budget() {
        let global: RetentionPolicy = serde_json::from_value(json!({"maxRetentionMinutes":1440,"maxRetentionMessages":3})).unwrap();
        assert_eq!(global.normalize(SourcePolicy::Delete, 3).unwrap(), NormalizedRetention { max_age_ms:Some(86_400_000), max_messages:Some(3), count_scope:Some(CountScope::WholeTopic) });
        let per_key: RetentionPolicy = serde_json::from_value(json!({"maxRetentionMessagesPerKey":3})).unwrap();
        assert_eq!(per_key.normalize(SourcePolicy::CompactDelete, 3).unwrap().count_scope, Some(CountScope::PerSourceKey));
        assert!(per_key.normalize(SourcePolicy::CompactDelete, 2).is_err());
    }

    #[test]
    fn expiry_addition_is_checked() {
        assert_eq!(expiry_ms(10, 5).unwrap(), 15);
        assert!(expiry_ms(u64::MAX, 1).is_err());
    }
}
