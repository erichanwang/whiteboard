// Kills a real process partway through a real write() to the write-ahead
// log and checks that recovery returns exactly the records that were fully
// written before the kill - the crash-recovery guarantee `wal` exists for,
// exercised end to end against an actual interrupted `write()` rather than
// simulated by hand-editing bytes in a unit test.
use std::env;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn temp_path(name: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    env::temp_dir().join(format!("whiteboard-wal-crash-test-{name}-{nanos}"))
}

#[test]
fn recovers_after_the_writer_process_is_killed_mid_write() {
    let path = temp_path("killed");
    let helper = env!("CARGO_BIN_EXE_wal_writer");

    let mut child = std::process::Command::new(helper)
        .arg(&path)
        .arg("5") // write records 0..4 normally, then start a slow, torn write of record 5
        .spawn()
        .expect("failed to launch wal_writer helper");

    // Give the helper time to finish the first five records and reach the
    // deliberate mid-write pause on the sixth before killing it.
    std::thread::sleep(Duration::from_millis(300));
    child.kill().expect("failed to send SIGKILL to wal_writer helper");
    child.wait().expect("failed to reap killed wal_writer helper");

    let recovered = whiteboard_lib::wal::recover(&path).unwrap();
    let expected: Vec<Vec<u8>> = (0..5).map(|index| format!("record-{index}").into_bytes()).collect();
    assert_eq!(recovered, expected, "recovery must return exactly the records fully written before the kill");

    // The repaired log must still accept new writes, proving recovery left
    // it in a usable state rather than merely a non-crashing one.
    whiteboard_lib::wal::append(&path, b"post-recovery").unwrap();
    let mut after = whiteboard_lib::wal::recover(&path).unwrap();
    assert_eq!(after.pop().unwrap(), b"post-recovery");
    assert_eq!(after, expected);

    std::fs::remove_file(&path).ok();
}
