//! Authored Rust helper for OS advisory locks; no Kafka or business logic.
//! Compiled with the repository-selected toolchain and held until Node closes stdin.
use std::{fs::OpenOptions, io::{self, Read, Write}};
fn main() -> Result<(), Box<dyn std::error::Error>> {
 let path = std::env::args_os().nth(1).ok_or("lock path required")?;
 let file = OpenOptions::new().create(true).append(true).open(path)?;
 file.try_lock().map_err(|_| "already has a live journal writer authority/orchestrator")?;
 println!("{{\"locked\":true}}"); io::stdout().flush()?;
 let mut buffer = [0u8; 256]; while io::stdin().read(&mut buffer)? != 0 {}
 drop(file); Ok(())
}
