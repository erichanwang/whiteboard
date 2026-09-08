// Test helper, not shipped in the app bundle: appends `count` records of the
// form "record-<n>" to the WAL at the given path, then starts one more
// write, pauses partway through it, and only finishes if not killed first.
// `wal::tests` spawns this as a real process and sends it a real SIGKILL
// during that pause, so the crash-recovery test exercises an actual
// interrupted `write()` instead of a hand-edited file.
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::time::Duration;

fn main() {
    let mut args = env::args().skip(1);
    let path = args.next().expect("usage: wal_writer <path> <count>");
    let count: usize = args
        .next()
        .expect("usage: wal_writer <path> <count>")
        .parse()
        .expect("count must be a number");

    for index in 0..count {
        let payload = format!("record-{index}");
        whiteboard_lib::wal::append(path.as_ref(), payload.as_bytes())
            .expect("append should succeed before the deliberate kill window");
    }

    // Start one more record but split the write in two, with a pause in the
    // middle long enough for the test to deliver SIGKILL. If the process
    // survives to the second half, this record legitimately completes -
    // the test only asserts on what happens when the kill lands in between.
    let extra = format!("record-{count}");
    let full_len = (extra.len() as u32).to_le_bytes();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .expect("failed to open log for the torn write");
    file.write_all(&full_len).expect("header length write failed");
    std::thread::sleep(Duration::from_secs(30));
    // Unreachable in the test, which kills the process during the sleep
    // above, but kept correct so this binary is also just a normal writer.
    file.write_all(&0_u32.to_le_bytes()).unwrap();
    file.write_all(extra.as_bytes()).unwrap();
    file.sync_all().unwrap();
}
