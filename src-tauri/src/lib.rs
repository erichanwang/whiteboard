use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use serde::{de::IgnoredAny, Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::{
    cmp::Ordering,
    collections::BinaryHeap,
    env, fs,
    io::{self, BufReader, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

const NVIDIA_API_URL: &str = "https://integrate.api.nvidia.com/v1";

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelRecord>,
}

#[derive(Debug, Deserialize)]
struct ModelRecord {
    id: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    message: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    max_tokens: u16,
    messages: Vec<Value>,
    model: String,
    stream: bool,
    temperature: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryBoardSummary {
    id: String,
    title: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryBoardPage {
    boards: Vec<LibraryBoardSummary>,
    has_more: bool,
}

struct LibraryBoardCandidate {
    id: String,
    path: PathBuf,
    modified: SystemTime,
}

impl PartialEq for LibraryBoardCandidate {
    fn eq(&self, other: &Self) -> bool {
        self.modified == other.modified && self.id == other.id
    }
}

impl Eq for LibraryBoardCandidate {}

impl PartialOrd for LibraryBoardCandidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for LibraryBoardCandidate {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .modified
            .cmp(&self.modified)
            .then_with(|| self.id.cmp(&other.id))
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryBoardMetadata {
    id: String,
    title: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct BoardIdentity {
    id: Option<Value>,
}

const ENCRYPTED_BOARD_MAGIC: &[u8; 8] = b"WBENC\0\r\n";
const ENCRYPTED_BOARD_HEADER_LEN: usize = 64;
const MAX_BOARD_BYTES: usize = 25_000_000;
const MAX_ENCRYPTED_BOARD_BYTES: usize = MAX_BOARD_BYTES + ENCRYPTED_BOARD_HEADER_LEN + 16;
const MAX_IMAGE_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PNG_EXPORT_BYTES: usize = 80 * 1024 * 1024;
const MAX_DIALOG_NAME_HEADER_CHARS: usize = 4 * 1024;
const MAX_API_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_API_ERROR_CHARS: usize = 500;
const MAX_MODEL_COUNT: usize = 500;
const MAX_PROFILE_IMAGE_BASE64_BYTES: usize = 10 * 1024 * 1024;
const MAX_RECOGNITION_IMAGE_BASE64_BYTES: usize = 8 * 1024 * 1024;
const MAX_RECOGNITION_TEXT_BYTES: usize = 32 * 1024;
const MAX_CREDENTIAL_FILE_BYTES: usize = 64 * 1024;
const MAX_CREDENTIAL_VALUE_BYTES: usize = 8 * 1024;
const MAX_LIBRARY_METADATA_BYTES: usize = 4 * 1024;
const LIBRARY_PAGE_SIZE: usize = 50;

fn validate_json(value: &str) -> Result<(), serde_json::Error> {
    serde_json::from_str::<IgnoredAny>(value).map(|_| ())
}

fn parse_board_identity(value: &str) -> Result<BoardIdentity, serde_json::Error> {
    serde_json::from_str(value)
}

fn derive_board_key(password: &[u8], salt: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(65_536, 3, 4, Some(32))
        .map_err(|_| "Could not configure password encryption.".to_string())?;
    let mut key = [0_u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password, salt, &mut key)
        .map_err(|_| "Could not derive the encryption key.".to_string())?;
    Ok(key)
}

fn encrypt_board(board_json: String, password: String) -> Result<Vec<u8>, String> {
    if !(8..=1024).contains(&password.len()) || board_json.len() > MAX_BOARD_BYTES {
        return Err("Use a passphrase of at least 8 characters for a valid board.".to_string());
    }
    validate_json(&board_json).map_err(|_| "The board data is not valid JSON.".to_string())?;
    let mut salt = [0_u8; 16];
    OsRng.fill_bytes(&mut salt);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let password = Zeroizing::new(password.into_bytes());
    let key = Zeroizing::new(derive_board_key(&password, &salt)?);
    let cipher = Aes256Gcm::new_from_slice(key.as_ref())
        .map_err(|_| "Could not initialize board encryption.".to_string())?;
    let mut header = [0_u8; ENCRYPTED_BOARD_HEADER_LEN];
    header[0..8].copy_from_slice(ENCRYPTED_BOARD_MAGIC);
    header[8] = 1;
    header[9] = 1;
    header[10] = 1;
    header[12..16].copy_from_slice(&(ENCRYPTED_BOARD_HEADER_LEN as u32).to_le_bytes());
    header[16..20].copy_from_slice(&65_536_u32.to_le_bytes());
    header[20..24].copy_from_slice(&3_u32.to_le_bytes());
    header[24..28].copy_from_slice(&4_u32.to_le_bytes());
    header[28..36].copy_from_slice(&(board_json.len() as u64).to_le_bytes());
    header[36..52].copy_from_slice(&salt);
    header[52..64].copy_from_slice(&nonce);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: board_json.as_bytes(),
                aad: &header,
            },
        )
        .map_err(|_| "Could not encrypt the board.".to_string())?;
    let mut encrypted = Vec::with_capacity(header.len() + ciphertext.len());
    encrypted.extend_from_slice(&header);
    encrypted.extend_from_slice(&ciphertext);
    Ok(encrypted)
}

fn decrypt_board(encrypted: Vec<u8>, password: String) -> Result<String, String> {
    if password.is_empty()
        || password.len() > 1024
        || encrypted.len() < ENCRYPTED_BOARD_HEADER_LEN + 16
    {
        return Err("The passphrase or encrypted board is invalid.".to_string());
    }
    let header = &encrypted[..ENCRYPTED_BOARD_HEADER_LEN];
    if &header[0..8] != ENCRYPTED_BOARD_MAGIC {
        return Err("This is not an encrypted Whiteboard file.".to_string());
    }
    if header[8] != 1
        || header[9] != 1
        || header[10] != 1
        || header[11] != 0
        || u32::from_le_bytes(header[12..16].try_into().unwrap())
            != ENCRYPTED_BOARD_HEADER_LEN as u32
        || u32::from_le_bytes(header[16..20].try_into().unwrap()) != 65_536
        || u32::from_le_bytes(header[20..24].try_into().unwrap()) != 3
        || u32::from_le_bytes(header[24..28].try_into().unwrap()) != 4
    {
        return Err("This encrypted Whiteboard format is not supported.".to_string());
    }
    let plaintext_len = u64::from_le_bytes(header[28..36].try_into().unwrap());
    let expected_len = ENCRYPTED_BOARD_HEADER_LEN as u64 + plaintext_len + 16;
    if plaintext_len > MAX_BOARD_BYTES as u64 || expected_len != encrypted.len() as u64 {
        return Err("The encrypted board length is invalid.".to_string());
    }
    let password = Zeroizing::new(password.into_bytes());
    let key = Zeroizing::new(derive_board_key(&password, &header[36..52])?);
    let cipher = Aes256Gcm::new_from_slice(key.as_ref())
        .map_err(|_| "Could not initialize board decryption.".to_string())?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&header[52..64]),
            Payload {
                msg: &encrypted[ENCRYPTED_BOARD_HEADER_LEN..],
                aad: header,
            },
        )
        .map_err(|_| "Could not decrypt: wrong passphrase or damaged file.".to_string())?;
    let board_json = String::from_utf8(plaintext)
        .map_err(|_| "The decrypted board is not valid text.".to_string())?;
    validate_json(&board_json).map_err(|_| "The decrypted board is not valid JSON.".to_string())?;
    Ok(board_json)
}

fn valid_board_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn open_bounded_regular_file(path: &Path, max_bytes: usize) -> io::Result<fs::File> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "board library entry is not a regular file",
        ));
    }
    if metadata.len() > max_bytes as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "board library entry is too large",
        ));
    }

    let file = fs::File::open(path)?;
    let opened_metadata = file.metadata()?;
    if !opened_metadata.file_type().is_file() || opened_metadata.len() > max_bytes as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "board library entry is invalid or too large",
        ));
    }
    #[cfg(unix)]
    if metadata.dev() != opened_metadata.dev() || metadata.ino() != opened_metadata.ino() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file changed while it was opened",
        ));
    }
    Ok(file)
}

fn read_bounded_regular_bytes(path: &Path, max_bytes: usize) -> io::Result<Vec<u8>> {
    let file = open_bounded_regular_file(path, max_bytes)?;
    let mut contents = Vec::with_capacity(file.metadata()?.len().min(max_bytes as u64) as usize);
    BufReader::new(file)
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut contents)?;
    if contents.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "board library entry is too large",
        ));
    }
    Ok(contents)
}

fn read_bounded_regular_file(path: &Path, max_bytes: usize) -> io::Result<String> {
    String::from_utf8(read_bounded_regular_bytes(path, max_bytes)?)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "file is not valid UTF-8 text"))
}

fn read_private_credential_file(path: &Path) -> io::Result<String> {
    let file = open_bounded_regular_file(path, MAX_CREDENTIAL_FILE_BYTES)?;
    let opened_metadata = file.metadata()?;
    #[cfg(unix)]
    if opened_metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "credential file permissions allow group or other access",
        ));
    }

    let mut contents =
        Vec::with_capacity(opened_metadata.len().min(MAX_CREDENTIAL_FILE_BYTES as u64) as usize);
    BufReader::new(file)
        .take(MAX_CREDENTIAL_FILE_BYTES as u64 + 1)
        .read_to_end(&mut contents)?;
    if contents.len() > MAX_CREDENTIAL_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "credential file is too large",
        ));
    }
    String::from_utf8(contents)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "file is not valid UTF-8 text"))
}

fn validate_library_board(board: &str, expected_id: &str) -> Result<(), String> {
    let identity = parse_board_identity(board)
        .map_err(|_| "The library board is not valid JSON.".to_string())?;
    if identity.id.as_ref().and_then(Value::as_str) != Some(expected_id) {
        return Err("The library board ID does not match the document.".to_string());
    }
    Ok(())
}

fn ensure_private_library_directory(directory: &Path) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    let path_metadata = fs::symlink_metadata(directory)?;
    if !path_metadata.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "board library path is not a real directory",
        ));
    }

    #[cfg(unix)]
    {
        let opened = fs::File::open(directory)?;
        let opened_metadata = opened.metadata()?;
        if !opened_metadata.file_type().is_dir()
            || path_metadata.dev() != opened_metadata.dev()
            || path_metadata.ino() != opened_metadata.ino()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "board library directory changed while it was opened",
            ));
        }
        opened.set_permissions(fs::Permissions::from_mode(0o700))?;

        let current_metadata = fs::symlink_metadata(directory)?;
        if !current_metadata.file_type().is_dir()
            || current_metadata.dev() != opened_metadata.dev()
            || current_metadata.ino() != opened_metadata.ino()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "board library directory changed while it was secured",
            ));
        }
    }
    Ok(())
}

fn library_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not find the application data directory: {error}"))?
        .join("boards");
    ensure_private_library_directory(&directory)
        .map_err(|error| format!("Could not create the board library: {error}"))?;
    Ok(directory)
}

fn write_private_new_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(contents)
}

fn write_board_atomically(
    directory: &Path,
    destination: &Path,
    board_id: &str,
    contents: &[u8],
) -> io::Result<()> {
    let mut nonce = [0_u8; 16];
    OsRng.fill_bytes(&mut nonce);
    let suffix = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temporary = directory.join(format!(".{board_id}-{suffix}.tmp"));
    let result = write_private_new_file(&temporary, contents)
        .and_then(|_| fs::rename(&temporary, destination));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn library_metadata_path(directory: &Path, board_id: &str) -> PathBuf {
    directory.join(format!("{board_id}.whiteboard.meta.json"))
}

fn write_library_metadata(
    directory: &Path,
    board_id: &str,
    metadata: &LibraryBoardMetadata,
) -> io::Result<()> {
    let contents = serde_json::to_vec(metadata)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if contents.len() > MAX_LIBRARY_METADATA_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "board metadata is too large",
        ));
    }
    write_board_atomically(
        directory,
        &library_metadata_path(directory, board_id),
        board_id,
        &contents,
    )
}

#[tauri::command]
fn save_library_board(
    app: tauri::AppHandle,
    board_json: String,
    board_id: String,
) -> Result<(), String> {
    if !valid_board_id(&board_id) || board_json.len() > MAX_BOARD_BYTES {
        return Err("The board data is invalid or too large.".to_string());
    }
    let parsed = serde_json::from_str::<LibraryBoardMetadata>(&board_json)
        .map_err(|_| "The board data is not valid JSON.".to_string())?;
    if parsed.id != board_id {
        return Err("The board ID does not match the document.".to_string());
    }
    let metadata = LibraryBoardMetadata {
        id: parsed.id,
        title: parsed.title.chars().take(200).collect(),
        updated_at: parsed.updated_at.chars().take(64).collect(),
    };
    let directory = library_directory(&app)?;
    let destination = directory.join(format!("{board_id}.whiteboard.json"));
    write_board_atomically(&directory, &destination, &board_id, board_json.as_bytes())
        .map_err(|error| format!("Could not save the board library file: {error}"))?;
    let _ = write_library_metadata(&directory, &board_id, &metadata);
    Ok(())
}

fn read_library_metadata(candidate: &LibraryBoardCandidate) -> Option<LibraryBoardMetadata> {
    let metadata_path = library_metadata_path(candidate.path.parent()?, &candidate.id);
    let sidecar_metadata = fs::symlink_metadata(&metadata_path).ok()?;
    if !sidecar_metadata.file_type().is_file()
        || sidecar_metadata.len() > MAX_LIBRARY_METADATA_BYTES as u64
        || sidecar_metadata.modified().ok()? <= candidate.modified
    {
        return None;
    }
    let contents = read_bounded_regular_file(&metadata_path, MAX_LIBRARY_METADATA_BYTES).ok()?;
    let parsed = serde_json::from_str::<LibraryBoardMetadata>(&contents).ok()?;
    (parsed.id == candidate.id).then_some(parsed)
}

fn collect_library_candidates(
    directory: &Path,
    retain_limit: usize,
) -> io::Result<Vec<LibraryBoardCandidate>> {
    let mut candidates = BinaryHeap::new();
    for entry in fs::read_dir(directory)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(id) = name.strip_suffix(".whiteboard.json") else {
            continue;
        };
        if !valid_board_id(id) {
            continue;
        }
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata)
                if metadata.file_type().is_file() && metadata.len() <= MAX_BOARD_BYTES as u64 =>
            {
                metadata
            }
            _ => continue,
        };
        candidates.push(LibraryBoardCandidate {
            id: id.to_string(),
            path,
            modified: metadata.modified().unwrap_or(UNIX_EPOCH),
        });
        if candidates.len() > retain_limit {
            candidates.pop();
        }
    }
    let mut candidates = candidates.into_vec();
    candidates.sort();
    Ok(candidates)
}

fn list_library_page(directory: &Path, offset: usize) -> io::Result<LibraryBoardPage> {
    let page_end = offset.saturating_add(LIBRARY_PAGE_SIZE);
    let mut candidates = collect_library_candidates(directory, page_end.saturating_add(1))?;
    let has_more = candidates.len() > page_end;
    candidates.truncate(page_end);
    let mut boards = Vec::with_capacity(LIBRARY_PAGE_SIZE);
    for candidate in candidates.into_iter().skip(offset).take(LIBRARY_PAGE_SIZE) {
        let (parsed, from_sidecar) = if let Some(parsed) = read_library_metadata(&candidate) {
            (parsed, true)
        } else {
            let Ok(file) = open_bounded_regular_file(&candidate.path, MAX_BOARD_BYTES) else {
                continue;
            };
            let Ok(parsed) = serde_json::from_reader::<_, LibraryBoardMetadata>(
                BufReader::new(file).take(MAX_BOARD_BYTES as u64 + 1),
            ) else {
                continue;
            };
            if parsed.id != candidate.id {
                continue;
            }
            (parsed, false)
        };
        let metadata = LibraryBoardMetadata {
            id: parsed.id,
            title: parsed.title.chars().take(200).collect(),
            updated_at: parsed.updated_at.chars().take(64).collect(),
        };
        if !from_sidecar {
            let _ = write_library_metadata(directory, &candidate.id, &metadata);
        }
        boards.push(LibraryBoardSummary {
            id: metadata.id,
            title: metadata.title,
            updated_at: metadata.updated_at,
        });
    }
    Ok(LibraryBoardPage { boards, has_more })
}

#[tauri::command]
fn list_library_boards(app: tauri::AppHandle, offset: usize) -> Result<LibraryBoardPage, String> {
    list_library_page(&library_directory(&app)?, offset)
        .map_err(|error| format!("Could not read the board library: {error}"))
}

#[tauri::command]
fn open_library_board(app: tauri::AppHandle, board_id: String) -> Result<String, String> {
    if !valid_board_id(&board_id) {
        return Err("The board ID is invalid.".to_string());
    }
    let board = read_bounded_regular_file(
        &library_directory(&app)?.join(format!("{board_id}.whiteboard.json")),
        MAX_BOARD_BYTES,
    )
    .map_err(|error| format!("Could not open the library board: {error}"))?;
    validate_library_board(&board, &board_id)?;
    Ok(board)
}

fn external_destination(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| "The selected destination has no file name.".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "The selected destination has no parent directory.".to_string())?
        .canonicalize()
        .map_err(|error| format!("Could not resolve the destination directory: {error}"))?;
    if !parent
        .metadata()
        .map_err(|error| format!("Could not inspect the destination directory: {error}"))?
        .is_dir()
    {
        return Err("The selected destination directory is invalid.".to_string());
    }
    let destination = parent.join(file_name);
    match fs::symlink_metadata(&destination) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err("The selected destination is not a regular file.".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Could not inspect the selected destination: {error}"
            ))
        }
    }
    Ok(destination)
}

fn decode_hex_dialog_name(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > MAX_DIALOG_NAME_HEADER_CHARS || value.len() % 2 != 0 {
        return Err("The default file name header is invalid.".to_string());
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().chunks_exact(2) {
        let pair = std::str::from_utf8(pair)
            .map_err(|_| "The default file name header is invalid.".to_string())?;
        bytes.push(
            u8::from_str_radix(pair, 16)
                .map_err(|_| "The default file name header is invalid.".to_string())?,
        );
    }
    let name = String::from_utf8(bytes)
        .map_err(|_| "The default file name is not valid UTF-8.".to_string())?;
    if !valid_dialog_file_name(&name) {
        return Err("The default file name is invalid.".to_string());
    }
    Ok(name)
}

fn valid_dialog_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 512
        && !name.chars().any(char::is_control)
        && !name.contains(['/', '\\'])
        && name != "."
        && name != ".."
}

fn read_external_board_path(path: &Path) -> Result<String, String> {
    read_bounded_regular_file(path, MAX_BOARD_BYTES)
        .map_err(|error| format!("Could not read the board file safely: {error}"))
}

fn dialog_path(path: tauri_plugin_dialog::FilePath) -> Result<PathBuf, String> {
    path.into_path()
        .map_err(|_| "The selected file path is not supported on this system.".to_string())
}

#[tauri::command]
async fn open_external_board_dialog(window: tauri::Window) -> Result<Option<String>, String> {
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("Whiteboard", &["json"])
        .blocking_pick_file();
    selected
        .map(dialog_path)
        .transpose()?
        .map(|path| read_external_board_path(&path))
        .transpose()
}

fn read_external_image_path(path: &Path) -> Result<Vec<u8>, String> {
    read_bounded_regular_bytes(path, MAX_IMAGE_FILE_BYTES)
        .map_err(|error| format!("Could not read the image safely: {error}"))
}

#[tauri::command]
async fn open_external_image_dialog(window: tauri::Window) -> Result<tauri::ipc::Response, String> {
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("Image", &["png", "jpg", "jpeg", "webp"])
        .blocking_pick_file();
    let contents = match selected {
        Some(path) => read_external_image_path(&dialog_path(path)?)?,
        None => Vec::new(),
    };
    Ok(tauri::ipc::Response::new(contents))
}

#[tauri::command]
async fn open_encrypted_board_dialog(
    window: tauri::Window,
    password: String,
) -> Result<Option<String>, String> {
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("Encrypted Whiteboard", &["enc"])
        .blocking_pick_file();
    let Some(path) = selected else {
        return Ok(None);
    };
    let encrypted = read_bounded_regular_bytes(&dialog_path(path)?, MAX_ENCRYPTED_BOARD_BYTES)
        .map_err(|error| format!("Could not read the encrypted board safely: {error}"))?;
    decrypt_board(encrypted, password).map(Some)
}

fn encrypt_external_board_path(
    path: &Path,
    board_json: String,
    password: String,
) -> Result<(), String> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("enc"))
    {
        return Err("The encrypted board destination must use a .enc extension.".to_string());
    }
    let destination = external_destination(path)?;
    let encrypted = encrypt_board(board_json, password)?;
    let directory = destination
        .parent()
        .ok_or_else(|| "The selected destination has no parent directory.".to_string())?;
    write_board_atomically(directory, &destination, "whiteboard-export", &encrypted)
        .map_err(|error| format!("Could not save the encrypted board safely: {error}"))
}

#[tauri::command]
async fn save_encrypted_board_dialog(
    window: tauri::Window,
    board_json: String,
    password: String,
    default_name: String,
) -> Result<bool, String> {
    if !valid_dialog_file_name(&default_name) {
        return Err("The default encrypted board file name is invalid.".to_string());
    }
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(default_name)
        .add_filter("Encrypted Whiteboard", &["enc"])
        .blocking_save_file();
    let Some(path) = selected else {
        return Ok(false);
    };
    encrypt_external_board_path(&dialog_path(path)?, board_json, password)?;
    Ok(true)
}

fn validate_png_export(length: usize, contents: &[u8]) -> Result<(), String> {
    if length > MAX_PNG_EXPORT_BYTES
        || contents.len() < 45
        || !contents.starts_with(b"\x89PNG\r\n\x1a\n")
        || u32::from_be_bytes(contents[8..12].try_into().unwrap()) != 13
        || &contents[12..16] != b"IHDR"
        || &contents[contents.len() - 12..contents.len() - 8] != [0, 0, 0, 0]
        || &contents[contents.len() - 8..contents.len() - 4] != b"IEND"
    {
        return Err("The PNG export is invalid or too large.".to_string());
    }
    let width = u32::from_be_bytes(contents[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(contents[20..24].try_into().unwrap());
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || width
            .checked_mul(height)
            .is_none_or(|pixels| pixels > 16 * 1024 * 1024)
    {
        return Err("The PNG export dimensions are invalid or too large.".to_string());
    }
    Ok(())
}

fn write_external_png_path(path: &Path, contents: &[u8]) -> Result<(), String> {
    validate_png_export(contents.len(), contents)?;
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("png"))
    {
        return Err("The PNG destination must use a .png extension.".to_string());
    }
    let destination = external_destination(path)?;
    let directory = destination
        .parent()
        .ok_or_else(|| "The selected destination has no parent directory.".to_string())?;
    write_board_atomically(directory, &destination, "whiteboard-png-export", contents)
        .map_err(|error| format!("Could not save the PNG safely: {error}"))
}

#[tauri::command]
async fn save_external_png_dialog(
    window: tauri::Window,
    request: tauri::ipc::Request<'_>,
) -> Result<bool, String> {
    let encoded_name = request
        .headers()
        .get("default-name-hex")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "The default file name header is missing.".to_string())?;
    let default_name = decode_hex_dialog_name(encoded_name)?;
    let contents = match request.body() {
        tauri::ipc::InvokeBody::Raw(contents) => contents.as_slice(),
        _ => return Err("The PNG export must use binary IPC.".to_string()),
    };
    validate_png_export(contents.len(), contents)?;
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(default_name)
        .add_filter("PNG image", &["png"])
        .blocking_save_file();
    let Some(path) = selected else {
        return Ok(false);
    };
    write_external_png_path(&dialog_path(path)?, contents)?;
    Ok(true)
}

fn credential_from_contents(
    contents: &str,
    name: &str,
) -> Result<Option<Zeroizing<String>>, String> {
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        if let Some((key, raw_value)) = line.split_once('=') {
            if key.trim() == name {
                let value = raw_value.trim().trim_matches(['\'', '"']);
                if value.len() > MAX_CREDENTIAL_VALUE_BYTES {
                    return Err(format!("{name} is too large."));
                }
                if !value.is_empty() {
                    return Ok(Some(Zeroizing::new(value.to_string())));
                }
            }
        }
    }
    Ok(None)
}

fn credential(app: &tauri::AppHandle, name: &str) -> Result<Zeroizing<String>, String> {
    if let Ok(value) = env::var(name) {
        if !value.trim().is_empty() {
            if value.len() > MAX_CREDENTIAL_VALUE_BYTES {
                return Err(format!("{name} is too large."));
            }
            return Ok(Zeroizing::new(value));
        }
    }

    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Could not find the home directory.".to_string())?;
    let contents = Zeroizing::new(
        read_private_credential_file(&home.join(".fcc/.env")).map_err(|error| {
            format!("{name} could not be read from a safe, bounded ~/.fcc/.env file: {error}")
        })?,
    );
    credential_from_contents(&contents, name)?
        .ok_or_else(|| format!("{name} is empty in ~/.fcc/.env."))
}

fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("message"))?
                .as_str()
                .map(|message| message.chars().take(MAX_API_ERROR_CHARS).collect())
        })
        .unwrap_or_else(|| format!("NVIDIA API returned {status}."))
}

fn api_client_builder(https_only: bool) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .https_only(https_only)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
}

fn api_client() -> Result<reqwest::Client, String> {
    api_client_builder(true)
        .build()
        .map_err(|error| format!("Could not initialize the NVIDIA client: {error}"))
}

fn checked_response_length(current: usize, additional: usize) -> Option<usize> {
    current
        .checked_add(additional)
        .filter(|total| *total <= MAX_API_RESPONSE_BYTES)
}

async fn read_bounded_response(
    mut response: reqwest::Response,
) -> Result<(reqwest::StatusCode, String), String> {
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_API_RESPONSE_BYTES as u64)
    {
        return Err("NVIDIA response is too large.".to_string());
    }
    let capacity = response.content_length().unwrap_or(0) as usize;
    let mut body = Vec::with_capacity(capacity.min(MAX_API_RESPONSE_BYTES));
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read NVIDIA response: {error}"))?
    {
        checked_response_length(body.len(), chunk.len())
            .ok_or_else(|| "NVIDIA response is too large.".to_string())?;
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body)
        .map(|body| (status, body))
        .map_err(|_| "NVIDIA returned a response that is not valid UTF-8.".to_string())
}

fn valid_image_payload(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

fn valid_model_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
}

#[tauri::command]
async fn list_nvidia_models(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let key = credential(&app, "NVIDIA_NIM_API_KEY")?;
    let response = api_client()?
        .get(format!("{NVIDIA_API_URL}/models"))
        .bearer_auth(key.as_str())
        .send()
        .await
        .map_err(|error| format!("Could not reach NVIDIA API: {error}"))?;
    let (status, body) = read_bounded_response(response).await?;
    if !status.is_success() {
        return Err(api_error(status, &body));
    }
    let mut models = serde_json::from_str::<ModelsResponse>(&body)
        .map_err(|_| "NVIDIA returned an invalid model list.".to_string())?
        .data
        .into_iter()
        .map(|record| record.id)
        .filter(|model| valid_model_name(model))
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    models.truncate(MAX_MODEL_COUNT);
    Ok(models)
}

#[tauri::command]
async fn recognize_with_nvidia(
    app: tauri::AppHandle,
    image: String,
    mode: String,
    model: String,
    corrections: Vec<String>,
    profile_image: Option<String>,
) -> Result<String, String> {
    if mode != "text" && mode != "latex" {
        return Err("Recognition mode must be text or latex.".to_string());
    }
    if !valid_model_name(&model) {
        return Err("The model name is invalid.".to_string());
    }
    if !valid_image_payload(&image, MAX_RECOGNITION_IMAGE_BASE64_BYTES) {
        return Err("The recognition image is invalid or too large.".to_string());
    }
    if corrections.len() > 100 || corrections.iter().any(|correction| correction.len() > 500) {
        return Err("The correction history is too large.".to_string());
    }
    if profile_image
        .as_deref()
        .is_some_and(|value| !valid_image_payload(value, MAX_PROFILE_IMAGE_BASE64_BYTES))
    {
        return Err("The handwriting profile image is invalid or too large.".to_string());
    }
    let key = credential(&app, "NVIDIA_NIM_API_KEY")?;
    let instruction = if mode == "latex" {
        "Read only the handwritten mathematical expression in the final image. Return valid LaTeX only, without delimiters, prose, or markdown fences."
    } else {
        "Read only the handwriting in the final image. Return the transcription only, preserving line breaks. Do not explain."
    };

    let mut messages = Vec::<Value>::new();
    if let Some(profile_image) = profile_image {
        messages.push(json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "This is the user's labeled handwriting reference sheet. Use it only to learn their letter and symbol shapes for the final image." },
                { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{profile_image}") } }
            ]
        }));
    }

    let hints = if corrections.is_empty() {
        String::new()
    } else {
        format!(
            "\nPrefer these user-confirmed corrections when relevant:\n{}",
            corrections.join("\n")
        )
    };
    messages.push(json!({
        "role": "user",
        "content": [
            { "type": "text", "text": format!("{instruction}{hints}") },
            { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{image}") } }
        ]
    }));

    let request = {
        let body = ChatRequest {
            max_tokens: 1024,
            messages,
            model,
            stream: false,
            temperature: 0.1,
        };
        api_client()?
            .post(format!("{NVIDIA_API_URL}/chat/completions"))
            .bearer_auth(key.as_str())
            .json(&body)
    };
    let response = request
        .send()
        .await
        .map_err(|error| format!("Could not reach NVIDIA API: {error}"))?;
    let (status, body) = read_bounded_response(response).await?;
    if !status.is_success() {
        return Err(api_error(status, &body));
    }

    let parsed = serde_json::from_str::<ChatResponse>(&body)
        .map_err(|_| "NVIDIA returned an invalid recognition response.".to_string())?;
    if let Some(error) = parsed.error {
        return Err(error.message.chars().take(MAX_API_ERROR_CHARS).collect());
    }
    let content = parsed
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content.trim().to_string())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| "The model returned no text.".to_string())?;
    if content.len() > MAX_RECOGNITION_TEXT_BYTES {
        return Err("The recognition response is too large.".to_string());
    }
    Ok(content)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            list_nvidia_models,
            recognize_with_nvidia,
            save_library_board,
            list_library_boards,
            open_library_board,
            open_external_board_dialog,
            open_external_image_dialog,
            open_encrypted_board_dialog,
            save_encrypted_board_dialog,
            save_external_png_dialog
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        api_client, api_client_builder, checked_response_length, collect_library_candidates,
        credential_from_contents, decode_hex_dialog_name, decrypt_board, encrypt_board,
        encrypt_external_board_path, ensure_private_library_directory, library_metadata_path,
        list_library_page, open_bounded_regular_file, parse_board_identity,
        read_bounded_regular_bytes, read_bounded_regular_file, read_external_board_path,
        read_external_image_path, read_private_credential_file, valid_board_id,
        valid_image_payload, valid_model_name, validate_json, validate_library_board,
        validate_png_export, write_board_atomically, write_external_png_path,
        write_library_metadata, write_private_new_file, ChatRequest, LibraryBoardMetadata,
        LIBRARY_PAGE_SIZE,
        MAX_API_RESPONSE_BYTES, MAX_BOARD_BYTES, MAX_CREDENTIAL_FILE_BYTES,
        MAX_CREDENTIAL_VALUE_BYTES, MAX_ENCRYPTED_BOARD_BYTES, MAX_IMAGE_FILE_BYTES,
        MAX_PNG_EXPORT_BYTES, MAX_PROFILE_IMAGE_BASE64_BYTES, MAX_RECOGNITION_IMAGE_BASE64_BYTES,
    };
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::{
        fs,
        io::{Cursor, Read, Write},
        net::TcpListener,
        path::PathBuf,
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    fn temporary_test_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("whiteboard-{name}-{}-{nonce}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        directory
    }

    fn minimal_png(width: u32, height: u32) -> Vec<u8> {
        let mut png = Vec::with_capacity(45);
        png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        png.extend_from_slice(&13_u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&width.to_be_bytes());
        png.extend_from_slice(&height.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        png.extend_from_slice(&[0; 4]);
        png.extend_from_slice(&0_u32.to_be_bytes());
        png.extend_from_slice(b"IEND");
        png.extend_from_slice(&[0; 4]);
        png
    }

    #[test]
    fn encrypted_board_round_trip_and_wrong_password_rejection() {
        let board = r#"{"version":1,"id":"test-board"}"#;
        let encrypted = encrypt_board(
            board.to_string(),
            "correct horse battery staple".to_string(),
        )
        .unwrap();
        assert_ne!(encrypted.as_slice(), board.as_bytes());
        assert_eq!(
            decrypt_board(
                encrypted.clone(),
                "correct horse battery staple".to_string()
            )
            .unwrap(),
            board
        );
        assert!(decrypt_board(encrypted, "wrong password".to_string()).is_err());
    }

    #[test]
    fn tampered_ciphertext_is_rejected_in_body_and_tag() {
        let board = r#"{"version":1,"id":"test-board"}"#;
        let password = "correct horse battery staple".to_string();
        let encrypted = encrypt_board(board.to_string(), password.clone()).unwrap();

        // Flip a byte in the encrypted body (right after the header).
        let mut tampered_body = encrypted.clone();
        let body_index = tampered_body.len() - 5;
        tampered_body[body_index] ^= 0x01;
        assert!(decrypt_board(tampered_body, password.clone()).is_err());

        // Flip a byte in the trailing GCM authentication tag.
        let mut tampered_tag = encrypted.clone();
        let tag_index = tampered_tag.len() - 1;
        tampered_tag[tag_index] ^= 0x01;
        assert!(decrypt_board(tampered_tag, password.clone()).is_err());

        // Sanity check: the untampered ciphertext still decrypts.
        assert_eq!(decrypt_board(encrypted, password).unwrap(), board);
    }

    #[test]
    fn board_ids_reject_path_traversal_and_absolute_paths() {
        assert!(valid_board_id("valid-board-id-123"));
        assert!(!valid_board_id(""));
        assert!(!valid_board_id(".."));
        assert!(!valid_board_id("../etc/passwd"));
        assert!(!valid_board_id("../../secrets"));
        assert!(!valid_board_id("/etc/passwd"));
        assert!(!valid_board_id("boards/../../etc/passwd"));
        assert!(!valid_board_id("a/b"));
        assert!(!valid_board_id("a\\b"));
        assert!(!valid_board_id("board id"));
        assert!(!valid_board_id(&"a".repeat(81)));
    }

    #[test]
    fn streaming_json_validation_checks_the_complete_document() {
        assert!(validate_json(r#"{"id":"test-board","strokes":[{"points":[1,2,3]}]}"#).is_ok());
        assert!(validate_json(r#"{"id":"test-board"} trailing"#).is_err());
        assert!(validate_json(r#"{"id":"test-board","strokes":[}"#).is_err());
    }

    #[test]
    fn api_response_length_is_bounded_and_overflow_safe() {
        assert_eq!(
            checked_response_length(MAX_API_RESPONSE_BYTES - 1, 1),
            Some(MAX_API_RESPONSE_BYTES)
        );
        assert_eq!(checked_response_length(MAX_API_RESPONSE_BYTES, 1), None);
        assert_eq!(checked_response_length(usize::MAX, 1), None);
    }

    #[test]
    fn api_client_does_not_follow_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let response = runtime
            .block_on(async {
                api_client_builder(false)
                    .build()
                    .unwrap()
                    .get(format!("http://{address}/start"))
                    .send()
                    .await
            })
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        server.join().unwrap();
    }

    #[test]
    fn api_client_rejects_plain_http() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let error = runtime
            .block_on(async {
                api_client()
                    .unwrap()
                    .get("http://example.com/")
                    .send()
                    .await
            })
            .unwrap_err();
        assert!(error.is_builder());
    }

    #[test]
    fn model_names_match_the_native_request_boundary() {
        assert!(valid_model_name("mistralai/model-1.2_test"));
        assert!(!valid_model_name(""));
        assert!(!valid_model_name("model with spaces"));
        assert!(!valid_model_name(&"x".repeat(161)));
    }

    #[test]
    fn credential_parser_handles_quotes_comments_and_value_bounds() {
        let contents = "# local keys\nOTHER=value\nNVIDIA_NIM_API_KEY = 'secret-value'\n";
        let parsed = credential_from_contents(contents, "NVIDIA_NIM_API_KEY")
            .unwrap()
            .unwrap();
        assert_eq!(parsed.as_str(), "secret-value");
        assert!(credential_from_contents(contents, "MISSING_KEY")
            .unwrap()
            .is_none());
        let oversized = format!(
            "NVIDIA_NIM_API_KEY={}",
            "x".repeat(MAX_CREDENTIAL_VALUE_BYTES + 1)
        );
        assert!(credential_from_contents(&oversized, "NVIDIA_NIM_API_KEY").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn credential_file_requires_private_unix_permissions_and_rejects_symlinks() {
        let directory = temporary_test_directory("credential-permissions");
        let credential = directory.join("credentials.env");
        let contents = "TEST_ONLY_KEY=test-only-value\n";
        fs::write(&credential, contents).unwrap();

        fs::set_permissions(&credential, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_private_credential_file(&credential).unwrap(), contents);

        fs::set_permissions(&credential, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            read_private_credential_file(&credential)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::PermissionDenied
        );

        fs::set_permissions(&credential, fs::Permissions::from_mode(0o600)).unwrap();
        let link = directory.join("credentials-link.env");
        std::os::unix::fs::symlink(&credential, &link).unwrap();
        assert!(read_private_credential_file(&link).is_err());

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn board_metadata_parsing_ignores_payload_fields() {
        let document = br#"{
            "version": 1,
            "id": "test-board",
            "title": "Test board",
            "updatedAt": "2026-07-21T12:00:00.000Z",
            "strokes": [{"points": [1, 2, 3]}],
            "images": [{"dataUrl": "data:image/png;base64,AAAA"}]
        }"#;
        let metadata = serde_json::from_reader::<_, LibraryBoardMetadata>(Cursor::new(document))
            .expect("metadata should parse");

        assert_eq!(metadata.id, "test-board");
        assert_eq!(metadata.title, "Test board");
        assert_eq!(metadata.updated_at, "2026-07-21T12:00:00.000Z");
        assert_eq!(
            parse_board_identity(std::str::from_utf8(document).unwrap())
                .unwrap()
                .id
                .unwrap(),
            "test-board"
        );
    }

    #[test]
    fn bounded_library_read_rejects_directories_and_oversized_files() {
        let directory = temporary_test_directory("bounded-read");
        assert!(open_bounded_regular_file(&directory, MAX_BOARD_BYTES).is_err());

        #[cfg(unix)]
        {
            let target = directory.join("target.whiteboard.json");
            let link = directory.join("link.whiteboard.json");
            fs::write(&target, r#"{"id":"target"}"#).unwrap();
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(open_bounded_regular_file(&link, MAX_BOARD_BYTES).is_err());
        }

        let oversized = directory.join("oversized.whiteboard.json");
        let file = fs::File::create(&oversized).unwrap();
        file.set_len(MAX_BOARD_BYTES as u64 + 1).unwrap();
        assert!(read_bounded_regular_file(&oversized, MAX_BOARD_BYTES).is_err());

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn bounded_library_read_accepts_valid_utf8_within_limit() {
        let directory = temporary_test_directory("valid-read");
        let board = directory.join("test-board.whiteboard.json");
        let document = r#"{"version":1,"id":"test-board"}"#;
        fs::write(&board, document).unwrap();

        assert_eq!(
            read_bounded_regular_file(&board, MAX_BOARD_BYTES).unwrap(),
            document
        );

        let oversized_credential = directory.join("oversized.env");
        let file = fs::File::create(&oversized_credential).unwrap();
        file.set_len(MAX_CREDENTIAL_FILE_BYTES as u64 + 1).unwrap();
        assert!(
            read_bounded_regular_file(&oversized_credential, MAX_CREDENTIAL_FILE_BYTES).is_err()
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn external_readers_enforce_text_and_kind_specific_size_limits() {
        let directory = temporary_test_directory("external-readers");
        let board = directory.join("board.whiteboard.json");
        fs::write(&board, r#"{"version":1}"#).unwrap();
        assert_eq!(
            read_external_board_path(&board).unwrap(),
            r#"{"version":1}"#
        );

        let invalid_text = directory.join("invalid.whiteboard.json");
        fs::write(&invalid_text, [0xff, 0xfe]).unwrap();
        assert!(read_external_board_path(&invalid_text).is_err());

        let oversized_image = directory.join("oversized.png");
        fs::File::create(&oversized_image)
            .unwrap()
            .set_len(MAX_IMAGE_FILE_BYTES as u64 + 1)
            .unwrap();
        assert!(read_external_image_path(&oversized_image).is_err());

        let encrypted_board = directory.join("valid.whiteboard.enc");
        let encrypted =
            encrypt_board(r#"{"version":1}"#.to_string(), "password".to_string()).unwrap();
        fs::write(&encrypted_board, &encrypted).unwrap();
        assert_eq!(
            decrypt_board(
                read_bounded_regular_bytes(&encrypted_board, MAX_ENCRYPTED_BOARD_BYTES).unwrap(),
                "password".to_string(),
            )
            .unwrap(),
            r#"{"version":1}"#
        );

        let oversized_encrypted = directory.join("oversized.whiteboard.enc");
        fs::File::create(&oversized_encrypted)
            .unwrap()
            .set_len(MAX_ENCRYPTED_BOARD_BYTES as u64 + 1)
            .unwrap();
        assert!(
            read_bounded_regular_bytes(&oversized_encrypted, MAX_ENCRYPTED_BOARD_BYTES).is_err()
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn encrypted_export_is_atomic_and_rejects_symlinks() {
        let directory = temporary_test_directory("encrypted-export");
        let destination = directory.join("snapshot.whiteboard.enc");
        encrypt_external_board_path(
            &destination,
            r#"{"version":1}"#.to_string(),
            "password".to_string(),
        )
        .unwrap();
        assert_eq!(
            decrypt_board(fs::read(&destination).unwrap(), "password".to_string()).unwrap(),
            r#"{"version":1}"#
        );

        let original = fs::read(&destination).unwrap();
        assert!(encrypt_external_board_path(
            &destination,
            "not json".to_string(),
            "password".to_string(),
        )
        .is_err());
        assert_eq!(fs::read(&destination).unwrap(), original);
        assert!(encrypt_external_board_path(
            &directory.join("snapshot.json"),
            r#"{"version":1}"#.to_string(),
            "password".to_string(),
        )
        .is_err());

        #[cfg(unix)]
        {
            let victim = directory.join("victim.txt");
            let link = directory.join("linked.whiteboard.enc");
            fs::write(&victim, "keep me").unwrap();
            std::os::unix::fs::symlink(&victim, &link).unwrap();
            assert!(encrypt_external_board_path(
                &link,
                r#"{"version":1}"#.to_string(),
                "password".to_string(),
            )
            .is_err());
            assert_eq!(fs::read_to_string(&victim).unwrap(), "keep me");
        }

        assert!(!fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".whiteboard-export-")));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn png_export_is_bounded_scoped_by_kind_and_atomic() {
        let directory = temporary_test_directory("png-export");
        let destination = directory.join("export.png");
        let png = minimal_png(640, 480);
        fs::write(&destination, "old contents").unwrap();
        write_external_png_path(&destination, &png).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), png);
        #[cfg(unix)]
        assert_eq!(
            fs::symlink_metadata(&destination)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        let mut invalid = png.clone();
        invalid[0] = 0;
        assert!(write_external_png_path(&destination, &invalid).is_err());
        assert_eq!(fs::read(&destination).unwrap(), png);
        assert!(validate_png_export(MAX_PNG_EXPORT_BYTES + 1, &png).is_err());
        let oversized_dimensions = minimal_png(8192, 8192);
        assert!(validate_png_export(oversized_dimensions.len(), &oversized_dimensions).is_err());
        assert!(write_external_png_path(&directory.join("wrong.jpg"), &png).is_err());

        let unicode_name = "Whiteboard 白板.png";
        let encoded = unicode_name
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(decode_hex_dialog_name(&encoded).unwrap(), unicode_name);
        assert!(decode_hex_dialog_name("0").is_err());
        assert!(decode_hex_dialog_name("zz").is_err());
        assert!(decode_hex_dialog_name("2f746d702f6578706f72742e706e67").is_err());
        assert!(decode_hex_dialog_name("6578706f72740a2e706e67").is_err());

        #[cfg(unix)]
        {
            let victim = directory.join("victim.txt");
            let link = directory.join("linked.png");
            fs::write(&victim, "keep me").unwrap();
            std::os::unix::fs::symlink(&victim, &link).unwrap();
            assert!(write_external_png_path(&link, &png).is_err());
            assert_eq!(fs::read_to_string(&victim).unwrap(), "keep me");
        }
        assert!(!fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".whiteboard-png-export-")));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn private_library_directory_rejects_symlinks_without_changing_the_target() {
        let parent = temporary_test_directory("private-library-directory");
        let real_directory = parent.join("real");
        ensure_private_library_directory(&real_directory).unwrap();
        assert!(fs::symlink_metadata(&real_directory)
            .unwrap()
            .file_type()
            .is_dir());

        #[cfg(unix)]
        {
            assert_eq!(
                fs::symlink_metadata(&real_directory)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            let target = parent.join("target");
            fs::create_dir(&target).unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
            let link = parent.join("boards");
            std::os::unix::fs::symlink(&target, &link).unwrap();

            assert!(ensure_private_library_directory(&link).is_err());
            assert_eq!(
                fs::symlink_metadata(&target).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }

        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn private_new_files_reject_symlinks_and_atomic_save_replaces_destination() {
        let directory = temporary_test_directory("atomic-save");
        let victim = directory.join("victim.txt");
        let temporary_attack = directory.join("attack.tmp");
        let destination = directory.join("test-board.whiteboard.json");
        fs::write(&victim, "keep me").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&victim, &temporary_attack).unwrap();
            assert!(write_private_new_file(&temporary_attack, b"overwrite").is_err());
            std::os::unix::fs::symlink(&victim, &destination).unwrap();
        }

        write_board_atomically(
            &directory,
            &destination,
            "test-board",
            br#"{"id":"test-board"}"#,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep me");
        assert_eq!(
            fs::read_to_string(&destination).unwrap(),
            r#"{"id":"test-board"}"#
        );
        assert!(fs::symlink_metadata(&destination)
            .unwrap()
            .file_type()
            .is_file());

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn library_pages_are_bounded_ordered_and_validate_filename_identity() {
        let directory = temporary_test_directory("library-pages");
        for index in 0..55_u64 {
            let id = format!("board-{index:02}");
            let path = directory.join(format!("{id}.whiteboard.json"));
            let title = if index == 54 {
                "x".repeat(250)
            } else {
                format!("Board {index}")
            };
            fs::write(
                &path,
                format!(
                    r#"{{"version":1,"id":"{id}","title":"{title}","updatedAt":"2026-07-21T12:00:00.000Z","strokes":[],"textObjects":[]}}"#
                ),
            )
            .unwrap();
            fs::File::open(&path)
                .unwrap()
                .set_times(
                    fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(index + 10)),
                )
                .unwrap();
        }

        let mismatch = directory.join("mismatch.whiteboard.json");
        fs::write(
            &mismatch,
            r#"{"version":1,"id":"other","title":"Mismatch","updatedAt":"2026-07-21","strokes":[],"textObjects":[]}"#,
        )
        .unwrap();
        fs::File::open(&mismatch)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1)))
            .unwrap();
        fs::write(directory.join("ignored.json"), "{}").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            directory.join("board-54.whiteboard.json"),
            directory.join("linked.whiteboard.json"),
        )
        .unwrap();

        let first = list_library_page(&directory, 0).unwrap();
        assert_eq!(first.boards.len(), LIBRARY_PAGE_SIZE);
        assert!(first.has_more);
        assert_eq!(first.boards.first().unwrap().id, "board-54");
        assert_eq!(first.boards.last().unwrap().id, "board-05");
        assert_eq!(first.boards.first().unwrap().title.chars().count(), 200);

        let second = list_library_page(&directory, LIBRARY_PAGE_SIZE).unwrap();
        assert_eq!(second.boards.len(), 5);
        assert!(!second.has_more);
        assert_eq!(second.boards.first().unwrap().id, "board-04");
        assert_eq!(second.boards.last().unwrap().id, "board-00");
        assert!(second.boards.iter().all(|board| board.id != "other"));

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn library_candidate_selection_retains_only_the_required_ordered_prefix() {
        let directory = temporary_test_directory("library-bounded-selection");
        let mut expected = Vec::new();
        for index in 0..320_u64 {
            let id = format!("stress-{index:04}");
            let modified_seconds = (index * 37) % 113 + 10;
            let path = directory.join(format!("{id}.whiteboard.json"));
            fs::write(
                &path,
                format!(
                    r#"{{"version":1,"id":"{id}","title":"Board {index}","updatedAt":"2026-07-21T12:00:00.000Z","strokes":[],"textObjects":[]}}"#
                ),
            )
            .unwrap();
            let modified = UNIX_EPOCH + Duration::from_secs(modified_seconds);
            fs::File::open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(modified))
                .unwrap();
            expected.push((id, modified));
        }
        expected.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));

        let offset = 137;
        let retain_limit = offset + LIBRARY_PAGE_SIZE + 1;
        let candidates = collect_library_candidates(&directory, retain_limit).unwrap();
        assert_eq!(candidates.len(), retain_limit);
        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.id.as_str())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .take(retain_limit)
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>()
        );

        let page = list_library_page(&directory, offset).unwrap();
        assert!(page.has_more);
        assert_eq!(page.boards.len(), LIBRARY_PAGE_SIZE);
        assert_eq!(
            page.boards
                .iter()
                .map(|board| board.id.as_str())
                .collect::<Vec<_>>(),
            expected
                .iter()
                .skip(offset)
                .take(LIBRARY_PAGE_SIZE)
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>()
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn library_listing_prefers_fresh_metadata_and_falls_back_when_stale() {
        let directory = temporary_test_directory("library-metadata");
        let id = "metadata-board";
        let board = directory.join(format!("{id}.whiteboard.json"));
        fs::write(
            &board,
            format!(
                r#"{{"version":1,"id":"{id}","title":"Board title","updatedAt":"2026-07-21T12:00:00.000Z","strokes":[],"textObjects":[]}}"#
            ),
        )
        .unwrap();
        fs::File::open(&board)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(10)))
            .unwrap();
        write_library_metadata(
            &directory,
            id,
            &LibraryBoardMetadata {
                id: id.to_string(),
                title: "Sidecar title".to_string(),
                updated_at: "2026-07-21T13:00:00.000Z".to_string(),
            },
        )
        .unwrap();

        let fresh = list_library_page(&directory, 0).unwrap();
        assert_eq!(fresh.boards[0].title, "Sidecar title");
        let sidecar = library_metadata_path(&directory, id);
        #[cfg(unix)]
        assert_eq!(
            fs::symlink_metadata(&sidecar).unwrap().permissions().mode() & 0o777,
            0o600
        );

        fs::File::open(&sidecar)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(5)))
            .unwrap();
        let stale = list_library_page(&directory, 0).unwrap();
        assert_eq!(stale.boards[0].title, "Board title");

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn library_board_validation_rejects_malformed_or_mismatched_documents() {
        assert!(validate_library_board(r#"{"id":"test-board"}"#, "test-board").is_ok());
        assert!(validate_library_board(r#"{"id":"test-board"} trailing"#, "test-board").is_err());
        assert!(validate_library_board(r#"{"id":"other-board"}"#, "test-board").is_err());
        assert!(validate_library_board(r#"{"title":"Missing ID"}"#, "test-board").is_err());
    }

    #[test]
    fn recognition_image_payloads_enforce_base64_charset_and_bounds() {
        assert!(valid_image_payload(
            "QUJDKy8=",
            MAX_RECOGNITION_IMAGE_BASE64_BYTES
        ));
        assert!(valid_image_payload(
            "QUJDKy8=",
            MAX_PROFILE_IMAGE_BASE64_BYTES
        ));
        assert!(!valid_image_payload("", MAX_RECOGNITION_IMAGE_BASE64_BYTES));
        assert!(!valid_image_payload(
            "not base64!!",
            MAX_RECOGNITION_IMAGE_BASE64_BYTES
        ));
        assert!(!valid_image_payload(
            &"A".repeat(MAX_RECOGNITION_IMAGE_BASE64_BYTES + 1),
            MAX_RECOGNITION_IMAGE_BASE64_BYTES
        ));
    }

    #[test]
    fn chat_request_serializes_the_fields_the_nvidia_api_expects() {
        let request = ChatRequest {
            max_tokens: 1024,
            messages: vec![serde_json::json!({ "role": "user" })],
            model: "test-model".to_string(),
            stream: false,
            temperature: 0.1,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["model"], "test-model");
        assert_eq!(value["stream"], false);
        assert_eq!(value["max_tokens"], 1024);
        assert_eq!(value["temperature"].as_f64().unwrap() as f32, 0.1_f32);
        assert_eq!(value["messages"].as_array().unwrap().len(), 1);
    }
}
