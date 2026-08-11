// A small write-ahead log: an append-only file of length-and-checksum-framed
// records. Every append is fsynced before it returns, so a record that made
// it into the log has made it to disk, not just to a buffer. Recovery scans
// the file from the start and stops at the first record that fails to check
// out - too short, or a checksum mismatch - which is exactly what a crash in
// the middle of a `write` leaves behind: a torn, partial record at the tail
// with everything before it intact. Recovery truncates the file to the last
// good record boundary, so the log is left in a state new appends can build
// on cleanly, and returns the payloads that were fully and correctly written.
//
// Record layout, little-endian: [4-byte length][4-byte crc32][payload].

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

const HEADER_LEN: u64 = 8;

// CRC-32 (IEEE 802.3 polynomial), computed directly rather than pulled in as
// a dependency - the whole point of a from-scratch WAL is not to outsource
// the part that decides whether a record survived.
fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// Append one record to the log, creating the file if it does not exist.
/// Returns only after the record's bytes are fsynced to disk.
pub fn append(path: &Path, payload: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let mut framed = Vec::with_capacity(HEADER_LEN as usize + payload.len());
    framed.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    framed.extend_from_slice(&crc32(payload).to_le_bytes());
    framed.extend_from_slice(payload);
    file.write_all(&framed)?;
    file.sync_all()
}

/// Scan the log from the start, returning every record that is fully present
/// and checksum-valid. Stops at the first record that is not - a short read
/// or a checksum mismatch, either of which means a write was interrupted
/// partway - and truncates the file at that point so the on-disk log matches
/// exactly what was recovered.
pub fn recover(path: &Path) -> io::Result<Vec<Vec<u8>>> {
    let mut file = match File::options().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };

    let mut records = Vec::new();
    let mut good_end: u64 = 0;
    let mut header = [0_u8; HEADER_LEN as usize];

    loop {
        let read = read_fully(&mut file, &mut header)?;
        if read < header.len() {
            break;
        }
        let length = u32::from_le_bytes(header[0..4].try_into().unwrap()) as usize;
        let expected_crc = u32::from_le_bytes(header[4..8].try_into().unwrap());

        let mut payload = vec![0_u8; length];
        let read = read_fully(&mut file, &mut payload)?;
        if read < length || crc32(&payload) != expected_crc {
            break;
        }

        good_end += HEADER_LEN + length as u64;
        records.push(payload);
    }

    let current_len = file.seek(SeekFrom::End(0))?;
    if current_len != good_end {
        file.set_len(good_end)?;
    }
    Ok(records)
}

fn read_fully(file: &mut File, buffer: &mut [u8]) -> io::Result<usize> {
    let mut total = 0;
    while total < buffer.len() {
        match file.read(&mut buffer[total..]) {
            Ok(0) => break,
            Ok(count) => total += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        env::temp_dir().join(format!("whiteboard-wal-test-{name}-{nanos}"))
    }

    #[test]
    fn recovers_every_record_written_cleanly() {
        let path = temp_path("clean");
        append(&path, b"first").unwrap();
        append(&path, b"second").unwrap();
        append(&path, b"").unwrap();
        append(&path, b"fourth").unwrap();

        let recovered = recover(&path).unwrap();
        assert_eq!(recovered, vec![b"first".to_vec(), b"second".to_vec(), Vec::new(), b"fourth".to_vec()]);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_file_recovers_as_empty() {
        let path = temp_path("missing");
        assert_eq!(recover(&path).unwrap(), Vec::<Vec<u8>>::new());
    }

    #[test]
    fn truncated_trailing_record_is_dropped_and_file_repaired() {
        let path = temp_path("torn");
        append(&path, b"kept-one").unwrap();
        append(&path, b"kept-two").unwrap();

        // Simulate a crash mid-write: a header for a record whose payload
        // never made it to disk, plus a header that is itself cut short.
        let good_len = std::fs::metadata(&path).unwrap().len();
        {
            let mut file = File::options().append(true).open(&path).unwrap();
            file.write_all(&(100_u32).to_le_bytes()).unwrap();
            file.write_all(&(0_u32).to_le_bytes()).unwrap();
            file.write_all(b"only part of the promised 100 bytes").unwrap();
            file.sync_all().unwrap();
        }

        let recovered = recover(&path).unwrap();
        assert_eq!(recovered, vec![b"kept-one".to_vec(), b"kept-two".to_vec()]);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), good_len);

        // The log must still be appendable after repair.
        append(&path, b"kept-three").unwrap();
        assert_eq!(
            recover(&path).unwrap(),
            vec![b"kept-one".to_vec(), b"kept-two".to_vec(), b"kept-three".to_vec()],
        );

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn corrupted_payload_is_dropped_by_checksum() {
        let path = temp_path("corrupt");
        append(&path, b"kept").unwrap();
        append(&path, b"will be corrupted").unwrap();

        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF; // flip a bit inside the second record's payload
        std::fs::write(&path, &bytes).unwrap();

        assert_eq!(recover(&path).unwrap(), vec![b"kept".to_vec()]);

        std::fs::remove_file(&path).ok();
    }
}
