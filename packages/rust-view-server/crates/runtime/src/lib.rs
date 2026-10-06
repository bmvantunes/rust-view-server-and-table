//! Native source adapters; no execution backend types belong here.
pub mod coordination;
pub mod durable;
pub mod durable_coordinator;
#[cfg(feature = "kafka")]
pub mod kafka;
pub mod registry;
pub mod wire;

pub mod subscriptions;
pub mod retention;

#[cfg(feature="fault-injection")]
pub mod faults;

pub mod kafka_state;
#[cfg(feature = "kafka-canonical")]
pub mod kafka_canonical;

pub mod row_delta;

pub mod health;
pub mod telemetry;
pub mod management;

extern crate self as product_source_ingestion;
pub mod service;

pub mod generic_source;

pub mod generic_owner;

#[cfg(feature="kafka-canonical")]
pub mod generic_kafka;

#[cfg(feature="kafka-canonical")]
pub mod generic_service;

mod expanded_source;

#[cfg(feature="kafka-canonical")]
pub mod generic_evolution;

pub mod complete;
